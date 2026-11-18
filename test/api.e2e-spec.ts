import { isPhoneOnlyEmail } from '@teamblind/axeda-better-auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createTenants,
  FRONTEND,
  signInByPhone,
  startApp,
  type Tenants,
  type TestApp,
  waitFor,
} from './helpers.js';

let t: TestApp;
let x: Tenants;
const location = { latitude: 20.676667, longitude: -103.347222 };

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
});
afterAll(async () => {
  await t?.close();
});

describe('Arranque y rutas', () => {
  it('/health es público', async () => {
    await request(t.server).get('/health').expect(200, { status: 'ok' });
  });

  it('una ruta desconocida da 404 sin detalles internos', async () => {
    const r = await request(t.server).get('/no-existe');
    expect(r.status).toBe(404);
    expect(r.text).not.toMatch(/stack|at .*\.ts/);
  });

  it('OpenAPI se genera desde los esquemas Zod', () => {
    const doc = t.openapi as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, any> };
    };
    expect(doc.paths['/sites/{siteId}']?.['put']).toBeDefined();
    const settings = Object.entries(doc.components.schemas).find(([k]) => k.startsWith('SiteSettings'))?.[1];
    expect(settings?.properties?.latitude).toMatchObject({ type: 'number', minimum: -90, maximum: 90 });
  });

  it('Better Auth y Axeda responden en /api/auth', async () => {
    await as(t, x.adminA).get('/api/auth/axeda/me').expect(200);
  });
});

describe('Autenticación', () => {
  it('sin sesión: 401', async () => {
    await request(t.server).get(`/companies/${x.companyA.id}/sites`).expect(401);
    await request(t.server).get(`/sites/${x.siteA1.id}`).expect(401);
  });

  it('CSRF: escritura con cookie desde un origen ajeno da 403', async () => {
    await request(t.server)
      .put(`/sites/${x.siteA1.id}`)
      .set('Cookie', x.adminA.cookie)
      .set('Origin', 'https://malo.example.com')
      .send(location)
      .expect(403);
  });

  it('la cookie de sesión es HttpOnly y SameSite=Lax', () => {
    const c = x.adminA.setCookie.find((h) => h.includes('session_token'))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });
});

describe('Aislamiento entre compañías', () => {
  beforeAll(async () => {
    await as(t, x.adminA).put(`/sites/${x.siteA1.id}`, location).expect(200);
    await as(t, x.adminB)
      .put(`/sites/${x.siteB1.id}`, { ...location, radiusM: 300 })
      .expect(200);
  });

  it('el administrador de A configura y ve solo las sedes de A', async () => {
    const r = await as(t, x.adminA).get(`/companies/${x.companyA.id}/sites`).expect(200);
    expect(r.body.map((s: { id: string }) => s.id)).toEqual([x.siteA1.id]);
    expect(r.body[0]).toMatchObject({
      companyId: x.companyA.id,
      businessId: null,
      radiusM: 500,
      latitude: 20.676667,
    });
  });

  it('el administrador de A recibe 403 sobre la compañía B y sus sedes', async () => {
    await as(t, x.adminA).get(`/companies/${x.companyB.id}/sites`).expect(403);
    await as(t, x.adminA).get(`/sites/${x.siteB1.id}`).expect(403);
    await as(t, x.adminA).put(`/sites/${x.siteB1.id}`, location).expect(403);
    await as(t, x.adminA).get(`/companies/${x.companyB.id}/audit`).expect(403);
  });

  it('una compañía o sede que no existe da el mismo 403 (no revela nada)', async () => {
    await as(t, x.adminA).get('/companies/no-existe/sites').expect(403);
    await as(t, x.adminA).get('/sites/no-existe').expect(403);
  });

  it('el dueño de la plataforma no ve datos de nómina de los clientes', async () => {
    await as(t, x.owner).get(`/companies/${x.companyA.id}/employees`).expect(403);
    await as(t, x.owner).get(`/sites/${x.siteA1.id}/employees`).expect(403);
    await as(t, x.owner).get(`/companies/${x.companyA.id}/audit`).expect(403);
  });

  it('el cuerpo inválido da 400', async () => {
    await as(t, x.adminA).put(`/sites/${x.siteA1.id}`, { latitude: 200 }).expect(400);
  });

  it('configurar una sede deja auditoría en su compañía y no en la otra', async () => {
    const a = await as(t, x.adminA).get(`/companies/${x.companyA.id}/audit`).expect(200);
    expect(a.body).toEqual([
      expect.objectContaining({ action: 'site.create', targetId: x.siteA1.id, actorUserId: x.adminA.userId }),
    ]);
    const b = await as(t, x.adminB).get(`/companies/${x.companyB.id}/audit`).expect(200);
    expect(b.body.map((e: { targetId: string }) => e.targetId)).toEqual([x.siteB1.id]);
  });

  it('50 peticiones concurrentes de A y B nunca cruzan datos', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const [user, company] = i % 2 ? [x.adminB, x.companyB] : [x.adminA, x.companyA];
        return as(t, user)
          .get(`/companies/${company.id}/sites`)
          .then((r) => ({ company: company.id, r }));
      }),
    );
    for (const { company, r } of results) {
      expect(r.status).toBe(200);
      for (const s of r.body) expect(s.companyId).toBe(company);
    }
  });
});

describe('Aislamiento entre sedes', () => {
  it('el líder de A1 ve su sede y sus empleados', async () => {
    await as(t, x.leaderA1).get(`/sites/${x.siteA1.id}`).expect(200);
    await as(t, x.leaderA1).get(`/sites/${x.siteA1.id}/employees`).expect(200);
  });

  it('el líder de A1 recibe 403 en otra sede de su misma compañía', async () => {
    await as(t, x.leaderA1).get(`/sites/${x.siteA2.id}`).expect(403);
    await as(t, x.leaderA1).get(`/sites/${x.siteA2.id}/employees`).expect(403);
  });

  it('el líder de A1 no ve la compañía entera ni configura la sede', async () => {
    await as(t, x.leaderA1).get(`/companies/${x.companyA.id}/sites`).expect(403);
    await as(t, x.leaderA1).get(`/companies/${x.companyA.id}/employees`).expect(403);
    await as(t, x.leaderA1).put(`/sites/${x.siteA1.id}`, location).expect(403);
  });

  it('el trabajador no administra sedes ni ve empleados', async () => {
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}`).expect(403);
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/employees`).expect(403);
  });

  it('el administrador de compañía alcanza todas sus sedes', async () => {
    await as(t, x.adminA).put(`/sites/${x.siteA2.id}`, location).expect(200);
    await as(t, x.adminA).get(`/sites/${x.siteA2.id}/employees`).expect(200);
  });
});

const invite = (scopeId: string, role: Parameters<Tenants['roleId']>[0], contact: object) => ({
  ...contact,
  scope: { type: 'site', id: scopeId },
  roleIds: [x.roleId(role)],
});

describe('Quién otorga qué (escalada lateral)', () => {
  it('el líder invita trabajadores a su sede por teléfono, y llega el SMS con el enlace', async () => {
    await as(t, x.leaderA1)
      .post(
        '/api/auth/axeda/invitation/create',
        invite(x.siteA1.id, 'worker', { phoneNumber: '+523311112222' }),
      )
      .expect(200);
    expect(await waitFor(t.sms, '+523311112222')).toMatch(/http:\/\/localhost:5173\/invitacion\?token=/);
  });

  it('el líder NO puede invitar ni asignar a otro líder, ni a un administrador', async () => {
    const r = await as(t, x.leaderA1).post(
      '/api/auth/axeda/invitation/create',
      invite(x.siteA1.id, 'leader', { email: 'otro.lider@example.com' }),
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TEMPORA_GRANT_FORBIDDEN');
    await as(t, x.leaderA1)
      .post('/api/auth/axeda/assignment/create', {
        userId: x.workerA1.userId,
        roleId: x.roleId('leader'),
        scope: { type: 'site', id: x.siteA1.id },
      })
      .expect(403);
    await as(t, x.leaderA1)
      .post(
        '/api/auth/axeda/invitation/create',
        invite(x.siteA1.id, 'company-admin', { email: 'x@example.com' }),
      )
      .expect(403);
  });

  it('el líder no invita en otra sede (lo impide Axeda)', async () => {
    const r = await as(t, x.leaderA1).post(
      '/api/auth/axeda/invitation/create',
      invite(x.siteA2.id, 'worker', { phoneNumber: '+523311113333' }),
    );
    expect(r.status).toBeGreaterThanOrEqual(403);
  });

  it('el líder designa un encargado en su sede, pero no quita a otro líder', async () => {
    await as(t, x.leaderA1)
      .post('/api/auth/axeda/assignment/create', {
        userId: x.workerA1.userId,
        roleId: x.roleId('acting-leader'),
        scope: { type: 'site', id: x.siteA1.id },
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      })
      .expect(200);
    const other = await t.auth.axeda.assignments.assign(x.adminA.actor, {
      userId: x.workerA1.userId,
      roleId: x.roleId('leader'),
      scope: { type: 'site', id: x.siteA1.id },
    });
    await as(t, x.leaderA1).post('/api/auth/axeda/assignment/revoke', { id: other.id }).expect(403);
    await as(t, x.adminA).post('/api/auth/axeda/assignment/revoke', { id: other.id }).expect(200);
  });

  it('el administrador de compañía sí invita líderes, por correo', async () => {
    await as(t, x.adminA)
      .post(
        '/api/auth/axeda/invitation/create',
        invite(x.siteA1.id, 'leader', { email: 'nuevo.lider@example.com' }),
      )
      .expect(200);
    expect(await waitFor(t.outbox, 'nuevo.lider@example.com')).toMatch(/\/invitacion\?token=/);
  });
});

describe('Acceso por teléfono', () => {
  it('registro por SMS, aceptar la invitación y quedar como trabajador de la sede', async () => {
    const phone = '+523344445555';
    await as(t, x.leaderA1)
      .post('/api/auth/axeda/invitation/create', {
        phoneNumber: phone,
        scope: { type: 'site', id: x.siteA1.id },
        roleIds: [x.roleId('worker')],
      })
      .expect(200);
    const token = new URL(/(http\S+)/.exec(await waitFor(t.sms, phone))![1]!).searchParams.get('token');

    const worker = await signInByPhone(t, phone);
    expect(isPhoneOnlyEmail(worker.email)).toBe(true);
    const accepted = await as(t, worker).post('/api/auth/axeda/invitation/accept', { token }).expect(200);
    expect(accepted.body.assignments[0]).toMatchObject({ scope: { type: 'site', id: x.siteA1.id } });
    const me = await as(t, worker)
      .get(`/api/auth/axeda/me?scopeType=site&scopeId=${x.siteA1.id}`)
      .expect(200);
    expect(me.body.permissions).toContain('attendance:mark');
  });

  it('rechaza números que no están en formato E.164', async () => {
    await request(t.server)
      .post('/api/auth/phone-number/send-otp')
      .set('Origin', FRONTEND)
      .send({ phoneNumber: '3312345678' })
      .expect(400);
  });
});
