import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type PilotInput, PilotSchema, setupPilot } from '../src/cli/pilot.js';
import {
  as,
  createTenants,
  createUser,
  FRONTEND,
  ownerRollback,
  startApp,
  type Tenants,
  type TestApp,
} from './helpers.js';

/** Semana 8 (ADR 0016): IP del cliente detrás de un proxy, salud con base de datos y alta del piloto. */

let t: TestApp;
let x: Tenants;

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
});
afterAll(async () => {
  await t?.close();
});

/** Consulta como dueño con la compañía fijada (RLS también aplica al dueño). */
const asCompany = <T extends object>(companyId: string, sql: string) =>
  ownerRollback<T>(async (c) => {
    await c.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    return (await c.query(sql, [companyId])).rows as T[];
  });

const statutoryCount = async (companyId: string) =>
  Number(
    (
      await asCompany<{ n: string }>(
        companyId,
        `SELECT count(*) AS n FROM app.holiday WHERE company_id = $1 AND source = 'statutory'`,
      )
    )[0]!.n,
  );

const signIn = (app: TestApp, ip: string) =>
  request(app.server)
    .post('/api/auth/sign-in/email')
    .set('Origin', FRONTEND)
    .set('X-Forwarded-For', ip)
    .send({ email: `nadie.${ip}@example.com`, password: 'contraseña-incorrecta-123' });

describe('IP del cliente (TRUST_PROXY)', () => {
  it('con proxy de confianza, cada cliente tiene su propio tope', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++) statuses.push((await signIn(t, `203.0.113.${i}`)).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});

describe('Salud', () => {
  it('/health y /health/ready responden sin sesión', async () => {
    expect((await request(t.server).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await request(t.server).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', database: 'ok', auth: 'ok' });
  });

  it('/health/ready da 503 si una conexión a la base no responde', async () => {
    const spy = vi.spyOn(t.auth.pool, 'query').mockRejectedValueOnce(new Error('sin conexión'));
    try {
      const ready = await request(t.server).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ status: 'unavailable', database: 'ok', auth: 'error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('están en OpenAPI', () => {
    const paths = t.openapi['paths'] as Record<string, unknown>;
    expect(paths).toHaveProperty('/health/ready');
  });
});

describe('Alta del piloto', () => {
  it('crea todo la primera vez y no duplica nada la segunda', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const lider = await createUser(t, 'liderPiloto', { ip: '10.8.0.1' });
    const phone = `+52133${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const adminEmail = `admin.piloto.${suffix}@example.com`;
    const input: PilotInput = PilotSchema.parse({
      owner: x.owner.email,
      company: { slug: `piloto-${suffix}`, name: 'Piloto SA' },
      business: { slug: 'manufactura', name: 'Manufactura' },
      site: {
        slug: 'gdl',
        name: 'Planta Guadalajara',
        settings: {
          latitude: 20.676667,
          longitude: -103.347222,
          radiusM: 250,
          shiftStart: '08:00',
          shiftEnd: '17:00',
        },
      },
      holidayYears: [2026, 2027],
      invitationTtlHours: 168,
      people: [
        { email: adminEmail, role: 'company-admin' },
        { email: lider.email.toUpperCase(), role: 'leader' },
        { phoneNumber: phone, role: 'worker' },
      ],
    });

    const first = await setupPilot(t.app, t.auth, input);
    expect(first.created).toEqual({ company: true, business: true, site: true, siteSettings: true });
    expect(first.people.map((p) => p.result)).toEqual(['invited', 'assigned', 'invited']);
    expect(t.sms.get(phone)).toMatch(/invitacion\?token=/);
    expect(t.outbox.get(adminEmail)).toMatch(/invitacion\?token=/);

    // El líder ya puede ver su sede con la configuración del archivo.
    const site = await as(t, lider).get(`/sites/${first.siteId}`);
    expect(site.status).toBe(200);
    expect(site.body).toMatchObject({
      radiusM: 250,
      shiftStart: '08:00',
      lateToleranceMin: 10,
      restDays: [0],
    });
    expect(site.body.businessId).toBe(first.businessId);

    const afterFirst = await statutoryCount(first.companyId);
    expect(afterFirst).toBeGreaterThanOrEqual(14);

    // Segunda corrida con otro radio: no crea nada, actualiza la sede.
    t.sms.delete(phone);
    const second = await setupPilot(t.app, t.auth, {
      ...input,
      site: { ...input.site, settings: { ...input.site.settings, radiusM: 300 } },
    });
    expect(second.created).toEqual({ company: false, business: false, site: false, siteSettings: false });
    expect([second.companyId, second.businessId, second.siteId]).toEqual([
      first.companyId,
      first.businessId,
      first.siteId,
    ]);
    expect(second.people.map((p) => p.result)).toEqual([
      'already-invited',
      'already-assigned',
      'already-invited',
    ]);
    expect(t.sms.has(phone)).toBe(false);
    expect((await as(t, lider).get(`/sites/${first.siteId}`)).body.radiusM).toBe(300);
    expect(await statutoryCount(first.companyId)).toBe(afterFirst);

    // Con resendInvitations, las pendientes se mandan otra vez.
    t.sms.delete(phone);
    const third = await setupPilot(t.app, t.auth, input, { resendInvitations: true });
    expect(third.people.map((p) => p.result)).toEqual(['invited', 'already-assigned', 'invited']);
    expect(t.sms.get(phone)).toMatch(/invitacion\?token=/);

    // Todo quedó auditado a nombre del dueño.
    const audit = await asCompany<{ action: string; actor_user_id: string }>(
      first.companyId,
      'SELECT action, actor_user_id FROM app.audit_log WHERE company_id = $1 ORDER BY id',
    );
    expect(audit.map((a) => a.action)).toContain('site.create');
    expect(audit.map((a) => a.action)).toContain('site.update');
    expect(audit.every((a) => a.actor_user_id === x.owner.userId)).toBe(true);
  });

  it('rechaza un archivo inválido con mensajes claros', () => {
    const r = PilotSchema.safeParse({
      owner: 'no-es-correo',
      company: { slug: 'Con Espacios', name: 'X' },
      site: { slug: 'gdl', name: 'GDL', settings: { latitude: 200, longitude: 0 } },
      people: [{ email: 'a@example.com', phoneNumber: '+5213312345678', role: 'worker' }],
    });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['owner', 'company.slug', 'site.settings.latitude', 'people.0']),
    );
  });

  it('falla si el dueño no existe', async () => {
    await expect(
      setupPilot(
        t.app,
        t.auth,
        PilotSchema.parse({
          owner: 'nadie@example.com',
          company: { slug: 'nunca', name: 'Nunca' },
          site: { slug: 'gdl', name: 'GDL', settings: { latitude: 20, longitude: -103 } },
        }),
      ),
    ).rejects.toThrow(/No existe el usuario/);
  });
});
