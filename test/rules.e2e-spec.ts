import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { RoleKey } from '../src/auth/permissions.js';
import { Clock } from '../src/common/clock.js';
import {
  acceptPrivacy,
  as,
  createTenants,
  createUser,
  PRIVACY_VERSION,
  startApp,
  type Tenants,
  type TestApp,
  type TestUser,
} from './helpers.js';

/**
 * Semanas 5 y 6 (ADR 0014): aviso de privacidad, retardos y entrada tardía, justificaciones, horas
 * extra, festivos y descansos. Sede A1: 08:00 a 17:00 en CDMX (UTC-6), tolerancia de 10 minutos,
 * descanso en domingo. Diciembre de 2026: el 1 es martes, el 5 sábado y el 6 domingo.
 */

let t: TestApp;
let x: Tenants;
let clock: Clock;
let ana: TestUser;
let beto: TestUser;
let carla: TestUser;
let dani: TestUser;
let encargado: TestUser;
let workerB1: TestUser;
/** Trabaja en A1 y en B1: el aviso se acepta en cada compañía. */
let doble: TestUser;
/** Nunca acepta el aviso. */
let nuevo: TestUser;

const SITE = { latitude: 20.676667, longitude: -103.347222 };
const NEAR = { latitude: 20.6768, longitude: -103.3474, accuracyM: 12 };
const A1 = { ...SITE, radiusM: 300, shiftStart: '08:00', shiftEnd: '17:00' };

const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};
const site = () => x.siteA1.id;
const newCode = async (ttlMinutes = 30, siteId = site(), by: TestUser = x.leaderA1) =>
  (await as(t, by).post(`/sites/${siteId}/daily-code`, { ttlMinutes }).expect(201)).body.code as string;
const checkIn = async (user: TestUser, siteId = site(), by: TestUser = x.leaderA1) =>
  as(t, user)
    .post(`/sites/${siteId}/attendance/check-in`, { code: await newCode(30, siteId, by), location: NEAR })
    .expect(201);
const checkOut = (user: TestUser, body: object = {}, siteId = site()) =>
  as(t, user).post(`/sites/${siteId}/attendance/check-out`, { location: NEAR, ...body });
const panel = (by: TestUser, date?: string) =>
  as(t, by).get(`/sites/${site()}/attendance/day${date ? `?date=${date}` : ''}`);
const calendar = (by: TestUser, month = '2026-12') =>
  as(t, by).get(`/sites/${site()}/attendance/me/calendar?month=${month}`);
const justify = (by: TestUser, body: object) => as(t, by).post(`/sites/${site()}/justifications`, body);
const authorize = (by: TestUser, body: object, siteId = site()) =>
  as(t, by).post(`/sites/${siteId}/overtime`, body);
const entryOf = (body: { entries: { person: { userId: string } }[] }, u: TestUser) =>
  body.entries.find((e) => e.person.userId === u.userId) as unknown as Record<string, unknown>;

async function auditOf(companyId: string, action: string) {
  const c = new pg.Client({ connectionString: inject('env')['DATABASE_URL'] });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    const { rows } = await c.query<{
      actor_user_id: string;
      reason: string | null;
      after: Record<string, unknown>;
    }>(`SELECT actor_user_id, reason, after FROM app.audit_log WHERE action = $1 ORDER BY id`, [action]);
    return rows;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const xlsxText = (body: Buffer) =>
  Object.entries(unzipSync(new Uint8Array(body)))
    .filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml'))
    .map(([, data]) => strFromU8(data))
    .join('\n');

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
  clock = t.app.get(Clock);
  const assign = (u: TestUser, key: RoleKey, siteId: string) =>
    t.auth.axeda.assignments.assign(x.owner.actor, {
      userId: u.userId,
      roleId: x.roleId(key),
      scope: { type: 'site', id: siteId },
    });
  ana = await createUser(t, 'Ana', { ip: '10.1.0.1' });
  beto = await createUser(t, 'Beto', { ip: '10.1.0.2' });
  carla = await createUser(t, 'Carla', { ip: '10.1.0.3' });
  dani = await createUser(t, 'Dani', { ip: '10.1.0.4' });
  encargado = await createUser(t, 'encargado', { ip: '10.1.0.5' });
  workerB1 = await createUser(t, 'workerB1', { ip: '10.1.0.6' });
  doble = await createUser(t, 'doble', { ip: '10.1.0.7' });
  nuevo = await createUser(t, 'nuevo', { ip: '10.1.0.8' });
  for (const u of [ana, beto, carla, dani, doble, nuevo]) await assign(u, 'worker', x.siteA1.id);
  await assign(encargado, 'acting-leader', x.siteA1.id);
  await assign(workerB1, 'worker', x.siteB1.id);
  await assign(doble, 'worker', x.siteB1.id);

  await as(t, x.adminA).put(`/sites/${x.siteA1.id}`, A1).expect(200);
  await as(t, x.adminA).put(`/sites/${x.siteA2.id}`, SITE).expect(200);
  await as(t, x.adminB).put(`/sites/${x.siteB1.id}`, A1).expect(200);
  await acceptPrivacy(t, x.siteA1.id, ana, beto, carla, dani, x.workerA1, x.leaderA1);
  await acceptPrivacy(t, x.siteB1.id, workerB1);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => setNow('2026-12-01T15:00:00Z'));

describe('Aviso de privacidad', () => {
  it('sin aceptarlo no se marca ni se ve la propia jornada: 403 con código estable', async () => {
    const status = await as(t, nuevo).get(`/sites/${site()}/privacy-notice`).expect(200);
    expect(status.body).toEqual({ version: PRIVACY_VERSION, accepted: false, acceptedAt: null });
    for (const res of [
      await as(t, nuevo).post(`/sites/${site()}/attendance/check-in`, { code: await newCode() }),
      await as(t, nuevo).post(`/sites/${site()}/attendance/late-check-in`, { code: '123456' }),
      await as(t, nuevo).post(`/sites/${site()}/attendance/check-out`, {}),
      await as(t, nuevo).get(`/sites/${site()}/attendance/me`),
      await calendar(nuevo),
      await justify(nuevo, { workDate: '2026-11-30', kind: 'absence', reason: 'Estuve enfermo' }),
      await as(t, nuevo).get(`/sites/${site()}/justifications/me`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEMPORA_PRIVACY_NOT_ACCEPTED', version: PRIVACY_VERSION });
    }
  });

  it('se acepta la versión vigente, una vez, con auditoría; otra versión es 409', async () => {
    const wrong = await as(t, doble).post(`/sites/${site()}/privacy-notice/accept`, { version: 'v0' });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'TEMPORA_PRIVACY_VERSION_MISMATCH', version: PRIVACY_VERSION });

    setNow('2026-12-01T13:00:00Z');
    const ok = await as(t, doble)
      .post(`/sites/${site()}/privacy-notice/accept`, { version: PRIVACY_VERSION })
      .expect(200);
    expect(ok.body).toEqual({
      version: PRIVACY_VERSION,
      accepted: true,
      acceptedAt: '2026-12-01T13:00:00.000Z',
    });
    setNow('2026-12-01T13:05:00Z');
    const again = await as(t, doble)
      .post(`/sites/${site()}/privacy-notice/accept`, { version: PRIVACY_VERSION })
      .expect(200);
    expect(again.body.acceptedAt).toBe('2026-12-01T13:00:00.000Z');
    const audit = (await auditOf(x.companyA.id, 'privacy.accept')).filter(
      (a) => a.actor_user_id === doble.userId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ version: PRIVACY_VERSION });
    await as(t, doble).get(`/sites/${site()}/attendance/me`).expect(200);
  });

  it('es por compañía: aceptarlo en A no vale en B', async () => {
    await as(t, doble).get(`/sites/${x.siteB1.id}/attendance/me`).expect(403);
    const b = await as(t, doble).get(`/sites/${x.siteB1.id}/privacy-notice`).expect(200);
    expect(b.body.accepted).toBe(false);
  });

  it('el panel del líder no depende del aviso, y solo quien marca acepta', async () => {
    await panel(encargado).expect(200);
    await as(t, encargado)
      .post(`/sites/${site()}/privacy-notice/accept`, { version: PRIVACY_VERSION })
      .expect(403);
    await as(t, x.owner).get(`/sites/${site()}/privacy-notice`).expect(403);
  });
});

describe('Retardos y entrada tardía (regla 10)', () => {
  it('dentro de la tolerancia no es retardo; pasarla sí, con los minutos', async () => {
    setNow('2026-12-01T14:10:00Z'); // 08:10
    const onTime = await checkIn(beto);
    expect(onTime.body).toMatchObject({ late: false, lateMinutes: 10, checkInCodeExpired: false });
    setNow('2026-12-01T14:25:00Z'); // 08:25
    const late = await checkIn(ana);
    expect(late.body).toMatchObject({ late: true, lateMinutes: 25 });
    const p = await panel(x.leaderA1).expect(200);
    expect(p.body).toMatchObject({ lateToleranceMin: 10, day: { dayType: 'ordinary', workday: true } });
    expect(entryOf(p.body, ana)).toMatchObject({ late: true, minutesAfterStart: 25 });
    expect(entryOf(p.body, beto)).toMatchObject({ late: false });
    expect(p.body.summary.late).toBe(1);
    const audit = await auditOf(x.companyA.id, 'attendance.check-in');
    expect(audit.find((a) => a.actor_user_id === ana.userId)?.after).toMatchObject({
      late: true,
      lateMinutes: 25,
    });
  });

  it('código vencido: la entrada normal lo rechaza y "entrada tardía" lo acepta, marcada', async () => {
    setNow('2026-12-02T13:30:00Z'); // 07:30
    const code = await newCode(20); // vence a las 07:50
    setNow('2026-12-02T14:20:00Z'); // 08:20
    const normal = await as(t, carla).post(`/sites/${site()}/attendance/check-in`, { code, location: NEAR });
    expect(normal.status).toBe(422);
    expect(normal.body.code).toBe('TEMPORA_CODE_EXPIRED');
    const late = await as(t, carla)
      .post(`/sites/${site()}/attendance/late-check-in`, { code, location: NEAR })
      .expect(201);
    expect(late.body).toMatchObject({ late: true, lateMinutes: 20, checkInCodeExpired: true });
    expect(await auditOf(x.companyA.id, 'attendance.late-check-in')).toEqual([
      expect.objectContaining({ actor_user_id: carla.userId }),
    ]);
  });

  it('entrada tardía: no con un código vigente ni con uno de otro día', async () => {
    setNow('2026-12-02T14:30:00Z');
    const fresh = await newCode();
    const r1 = await as(t, dani).post(`/sites/${site()}/attendance/late-check-in`, { code: fresh });
    expect(r1.body.code).toBe('TEMPORA_CODE_STILL_VALID');
    setNow('2026-12-03T14:30:00Z');
    const r2 = await as(t, dani).post(`/sites/${site()}/attendance/late-check-in`, { code: fresh });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('TEMPORA_CODE_NOT_TODAY');
  });

  it('la tolerancia es de la sede y no cambia los retardos ya registrados', async () => {
    await as(t, x.adminA)
      .put(`/sites/${site()}`, { ...A1, lateToleranceMin: 30 })
      .expect(200);
    setNow('2026-12-03T14:25:00Z');
    expect((await checkIn(ana)).body).toMatchObject({ late: false, lateMinutes: 25 });
    const dec1 = await panel(x.leaderA1, '2026-12-01').expect(200);
    expect(entryOf(dec1.body, ana)).toMatchObject({ late: true });
    await as(t, x.adminA).put(`/sites/${site()}`, A1).expect(200);
  });

  it('el marcado manual también cuenta retardo; en domingo de descanso, no', async () => {
    setNow('2026-12-04T15:00:00Z'); // viernes 09:00
    const manual = await as(t, x.leaderA1)
      .post(`/sites/${site()}/attendance/manual/check-in`, {
        userId: dani.userId,
        comment: 'Sin teléfono hoy',
      })
      .expect(201);
    expect(manual.body).toMatchObject({ late: true, lateMinutes: 60, checkInSource: 'manual' });
    setNow('2026-12-06T15:00:00Z'); // domingo 09:00
    const sunday = await checkIn(beto);
    expect(sunday.body).toMatchObject({ late: false, lateMinutes: 60 });
    const me = await as(t, beto).get(`/sites/${site()}/attendance/me`).expect(200);
    expect(me.body.day).toEqual({ dayType: 'rest', sunday: true, holidayName: null, workday: false });
  });
});

describe('Justificaciones (regla 12, versión simple)', () => {
  let lateId: string;

  it('el trabajador justifica su retardo; una por día y tipo', async () => {
    setNow('2026-12-01T20:00:00Z');
    const r = await justify(ana, {
      workDate: '2026-12-01',
      kind: 'late',
      reason: 'Se descompuso el camión',
    }).expect(201);
    expect(r.body).toMatchObject({
      userId: ana.userId,
      workDate: '2026-12-01',
      kind: 'late',
      status: 'pending',
      resolvedBy: null,
    });
    expect(r.body.attendanceRecordId).toEqual(expect.any(String));
    lateId = r.body.id;
    const dup = await justify(ana, { workDate: '2026-12-01', kind: 'late', reason: 'Otra vez el camión' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TEMPORA_JUSTIFICATION_EXISTS');
    const mine = await as(t, ana).get(`/sites/${site()}/justifications/me`).expect(200);
    expect(mine.body.map((j: { id: string }) => j.id)).toContain(lateId);
  });

  it('solo lo que tiene sentido: no un retardo que no fue, ni una falta en descanso o con jornada', async () => {
    setNow('2026-12-08T15:00:00Z');
    const cases: [TestUser, object][] = [
      [beto, { workDate: '2026-12-01', kind: 'late', reason: 'No llegué tarde' }],
      [beto, { workDate: '2026-12-01', kind: 'early-exit', reason: 'No salí antes' }],
      [beto, { workDate: '2026-12-01', kind: 'absence', reason: 'Sí vine ese día' }],
      [carla, { workDate: '2026-12-06', kind: 'absence', reason: 'Era domingo de descanso' }],
      [carla, { workDate: '2026-12-09', kind: 'absence', reason: 'Todavía no llega' }],
      [carla, { workDate: '2026-10-01', kind: 'absence', reason: 'Hace mucho tiempo' }],
    ];
    for (const [u, body] of cases) {
      const res = await justify(u, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('TEMPORA_JUSTIFICATION_INVALID');
    }
    await justify(carla, { workDate: '2026-12-07', kind: 'absence', reason: 'Cita en el IMSS' }).expect(201);
  });

  it('el líder ve las pendientes y aprueba; rechazar exige comentario; se resuelve una vez', async () => {
    setNow('2026-12-02T15:00:00Z');
    const list = await as(t, x.leaderA1).get(`/sites/${site()}/justifications?status=pending`).expect(200);
    const item = list.body.items.find((j: { id: string }) => j.id === lateId);
    expect(item).toMatchObject({ status: 'pending', person: { userId: ana.userId, name: 'Ana' } });

    await as(t, x.leaderA1).post(`/sites/${site()}/justifications/${lateId}/reject`, {}).expect(400);
    const ok = await as(t, x.leaderA1)
      .post(`/sites/${site()}/justifications/${lateId}/approve`, { comment: 'Hubo bloqueo en la carretera' })
      .expect(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      resolvedBy: x.leaderA1.userId,
      resolvedAt: '2026-12-02T15:00:00.000Z',
      resolutionComment: 'Hubo bloqueo en la carretera',
    });
    const again = await as(t, x.leaderA1).post(`/sites/${site()}/justifications/${lateId}/reject`, {
      comment: 'Cambié de opinión',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TEMPORA_JUSTIFICATION_RESOLVED');
    expect(await auditOf(x.companyA.id, 'justification.approve')).toEqual([
      expect.objectContaining({ actor_user_id: x.leaderA1.userId, reason: 'Hubo bloqueo en la carretera' }),
    ]);
  });

  it('el rechazo queda con su comentario y se ve en el calendario', async () => {
    setNow('2026-12-08T16:00:00Z');
    const [absence] = (
      await as(t, x.leaderA1).get(`/sites/${site()}/justifications?status=pending`).expect(200)
    ).body.items.filter((j: { userId: string }) => j.userId === carla.userId);
    const r = await as(t, x.leaderA1)
      .post(`/sites/${site()}/justifications/${absence.id}/reject`, { comment: 'No trajo comprobante' })
      .expect(200);
    expect(r.body).toMatchObject({ status: 'rejected', resolutionComment: 'No trajo comprobante' });
    const cal = await calendar(carla).expect(200);
    expect(cal.body.days.find((d: { date: string }) => d.date === '2026-12-07')).toMatchObject({
      status: 'no-record',
      justifications: [{ kind: 'absence', status: 'rejected' }],
    });
  });

  it('el trabajador y el encargado no resuelven; otra compañía tampoco; nadie la suya', async () => {
    await as(t, ana).get(`/sites/${site()}/justifications`).expect(403);
    await as(t, ana).post(`/sites/${site()}/justifications/${lateId}/approve`, {}).expect(403);
    await as(t, encargado).get(`/sites/${site()}/justifications`).expect(403);
    await as(t, x.adminB).get(`/sites/${site()}/justifications`).expect(403);
    // Desde su propia compañía, la de A no existe.
    const other = await as(t, x.adminB).post(`/sites/${x.siteB1.id}/justifications/${lateId}/approve`, {});
    expect(other.status).toBe(404);

    // El líder también marca: si él llega tarde, su justificación la resuelve otro.
    setNow('2026-12-09T14:40:00Z');
    await checkIn(x.leaderA1);
    const own = await justify(x.leaderA1, {
      workDate: '2026-12-09',
      kind: 'late',
      reason: 'Junta en oficinas',
    }).expect(201);
    const self = await as(t, x.leaderA1).post(`/sites/${site()}/justifications/${own.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('TEMPORA_JUSTIFICATION_SELF');
    await as(t, x.adminA).post(`/sites/${site()}/justifications/${own.body.id}/approve`, {}).expect(200);
  });
});

describe('Horas extra (regla 9)', () => {
  // Martes 15 de diciembre: cierre a las 17:00 (23:00Z).
  const D = '2026-12-15';

  it('autorizada antes, hasta una hora: la salida tarde no va a revisión y los minutos cuadran', async () => {
    setNow(`${D}T13:00:00Z`);
    const auth = await authorize(x.leaderA1, {
      userId: ana.userId,
      until: '2026-12-15T19:00:00-06:00',
      reason: 'Pedido urgente de cliente',
    }).expect(201);
    expect(auth.body).toMatchObject({
      userId: ana.userId,
      workDate: D,
      until: '2026-12-16T01:00:00.000Z',
      effectiveUntil: '2026-12-16T01:00:00.000Z',
      authorizedBy: x.leaderA1.userId,
      closedAt: null,
    });
    setNow(`${D}T14:00:00Z`);
    await checkIn(ana);
    setNow(`${D}T23:30:00Z`); // 17:30: va en curso
    const me = await as(t, ana).get(`/sites/${site()}/attendance/me`).expect(200);
    expect(me.body.record.overtime).toMatchObject({
      inProgress: true,
      extraMinutes: 30,
      authorizedMinutes: 30,
      unauthorizedMinutes: 0,
      authorization: { id: auth.body.id },
    });
    setNow('2026-12-16T00:30:00Z'); // 18:30
    const out = await checkOut(ana).expect(200);
    expect(out.body.reviewReasons).toEqual([]);
    expect(out.body.overtime).toMatchObject({
      scheduledEnd: '2026-12-15T23:00:00.000Z',
      inProgress: false,
      extraMinutes: 90,
      authorizedMinutes: 90,
      unauthorizedMinutes: 0,
    });
  });

  it('sin autorización: tiempo no autorizado y "por revisar"', async () => {
    setNow(`${D}T14:00:00Z`);
    await checkIn(beto);
    setNow('2026-12-16T00:30:00Z');
    const out = await checkOut(beto).expect(200);
    expect(out.body.reviewReasons).toEqual(['exit:off-schedule']);
    expect(out.body.overtime).toMatchObject({
      extraMinutes: 90,
      authorizedMinutes: 0,
      unauthorizedMinutes: 90,
    });
  });

  it('jornada abierta que el líder cierra: lo de después no está autorizado', async () => {
    setNow(`${D}T14:00:00Z`);
    await checkIn(carla);
    setNow(`${D}T22:00:00Z`); // en vivo, a las 16:00
    const open = await authorize(x.leaderA1, {
      userId: carla.userId,
      until: null,
      reason: 'Inventario de fin de año',
    }).expect(201);
    expect(open.body).toMatchObject({ until: null, effectiveUntil: null });
    setNow('2026-12-16T00:00:00Z'); // 18:00
    const closed = await as(t, x.leaderA1)
      .post(`/sites/${site()}/overtime/${open.body.id}/close`)
      .expect(200);
    expect(closed.body).toMatchObject({
      closedBy: x.leaderA1.userId,
      effectiveUntil: '2026-12-16T00:00:00.000Z',
    });
    const twice = await as(t, x.leaderA1).post(`/sites/${site()}/overtime/${open.body.id}/close`);
    expect(twice.body.code).toBe('TEMPORA_OVERTIME_CLOSED');
    setNow('2026-12-16T01:00:00Z'); // 19:00
    const out = await checkOut(carla).expect(200);
    expect(out.body.overtime).toMatchObject({
      extraMinutes: 120,
      authorizedMinutes: 60,
      unauthorizedMinutes: 60,
    });
    expect(out.body.reviewReasons).toEqual(['exit:off-schedule']);

    const list = await as(t, x.leaderA1).get(`/sites/${site()}/overtime?date=${D}`).expect(200);
    expect(list.body.items.map((i: { person: { name: string } }) => i.person.name).toSorted()).toEqual([
      'Ana',
      'Carla',
    ]);
    expect(
      list.body.items.find((i: { person: { name: string } }) => i.person.name === 'Carla').record.overtime,
    ).toMatchObject({ unauthorizedMinutes: 60 });
  });

  it('en vivo después del cierre: cubre desde el cierre oficial hasta que el líder la cierra', async () => {
    setNow('2026-12-16T14:00:00Z');
    await checkIn(dani);
    setNow('2026-12-17T00:00:00Z'); // 18:00, una hora después del cierre
    const before = await as(t, dani).get(`/sites/${site()}/attendance/me`).expect(200);
    expect(before.body.record.overtime).toMatchObject({ extraMinutes: 60, unauthorizedMinutes: 60 });
    const auth = await authorize(x.leaderA1, {
      userId: dani.userId,
      until: null,
      reason: 'Se quedó a terminar',
    }).expect(201);
    const live = await as(t, dani).get(`/sites/${site()}/attendance/me`).expect(200);
    expect(live.body.record.overtime).toMatchObject({
      inProgress: true,
      authorizedMinutes: 60,
      unauthorizedMinutes: 0,
    });
    await as(t, x.leaderA1).post(`/sites/${site()}/overtime/${auth.body.id}/close`).expect(200);
    setNow('2026-12-17T00:05:00Z');
    const out = await checkOut(dani).expect(200);
    expect(out.body.overtime).toMatchObject({
      extraMinutes: 65,
      authorizedMinutes: 60,
      unauthorizedMinutes: 5,
    });
    expect(out.body.reviewReasons).toEqual([]);
  });

  it('no después de la salida, no para uno mismo, no fuera de la plantilla ni sin horario', async () => {
    setNow('2026-12-16T02:00:00Z');
    const after = await authorize(x.leaderA1, {
      userId: beto.userId,
      workDate: D,
      reason: 'Ya se había ido',
    });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('TEMPORA_OVERTIME_AFTER_EXIT');

    setNow(`${D}T15:00:00Z`);
    const self = await authorize(x.leaderA1, { userId: x.leaderA1.userId, reason: 'Para mí mismo' });
    expect(self.body.code).toBe('TEMPORA_MANUAL_SELF');
    const notHere = await authorize(x.leaderA1, { userId: workerB1.userId, reason: 'De otra compañía' });
    expect(notHere.body.code).toBe('TEMPORA_NOT_SITE_EMPLOYEE');
    const before = await authorize(x.leaderA1, {
      userId: dani.userId,
      until: '2026-12-15T16:00:00-06:00',
      reason: 'Antes del cierre',
    });
    expect(before.body.code).toBe('TEMPORA_OVERTIME_INVALID');
    const far = await authorize(x.leaderA1, {
      userId: dani.userId,
      workDate: '2026-12-30',
      reason: 'Muy adelante',
    });
    expect(far.body.code).toBe('TEMPORA_OVERTIME_INVALID');
    const noShift = await authorize(
      x.adminA,
      { userId: dani.userId, reason: 'Sede sin horario' },
      x.siteA2.id,
    );
    expect([409, 422]).toContain(noShift.status);
  });

  it('solo el líder autoriza (el encargado y el trabajador no), y solo en su sede', async () => {
    setNow(`${D}T15:00:00Z`);
    await authorize(encargado, { userId: dani.userId, reason: 'Sin permiso' }).expect(403);
    await authorize(ana, { userId: dani.userId, reason: 'Sin permiso' }).expect(403);
    await authorize(x.leaderA1, { userId: dani.userId, reason: 'Otra sede' }, x.siteA2.id).expect(403);
    await authorize(x.adminB, { userId: dani.userId, reason: 'Otra compañía' }).expect(403);
    expect(await auditOf(x.companyA.id, 'overtime.authorize')).toHaveLength(3);
    expect(await auditOf(x.companyA.id, 'overtime.close')).toHaveLength(2);
  });
});

describe('Festivos y descansos (reglas 15 y 16)', () => {
  it('el administrador carga los festivos de la LFT de 2027 una sola vez', async () => {
    const r = await as(t, x.adminA)
      .post(`/companies/${x.companyA.id}/holidays/statutory`, { year: 2027 })
      .expect(200);
    expect(r.body.items.map((h: { date: string }) => h.date)).toEqual([
      '2027-01-01',
      '2027-02-01',
      '2027-03-15',
      '2027-05-01',
      '2027-09-16',
      '2027-11-15',
      '2027-12-25',
    ]);
    expect(r.body.items[0]).toMatchObject({ siteId: null, source: 'statutory', name: 'Año Nuevo' });
    const again = await as(t, x.adminA)
      .post(`/companies/${x.companyA.id}/holidays/statutory`, { year: 2027 })
      .expect(200);
    expect(again.body.items).toHaveLength(7);
  });

  it('festivos de la compañía y de una sede; repetir una fecha es 409', async () => {
    await as(t, x.adminA)
      .post(`/companies/${x.companyA.id}/holidays`, { date: '2026-12-25', name: 'Navidad' })
      .expect(201);
    const dup = await as(t, x.adminA).post(`/companies/${x.companyA.id}/holidays`, {
      date: '2026-12-25',
      name: 'Navidad otra vez',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TEMPORA_HOLIDAY_EXISTS');
    await as(t, x.adminA)
      .post(`/sites/${site()}/holidays`, { date: '2026-12-12', name: 'Virgen de Guadalupe' })
      .expect(201);
    const a1 = await as(t, x.leaderA1).get(`/sites/${site()}/holidays?year=2026`).expect(200);
    expect(a1.body.items.map((h: { name: string }) => h.name)).toEqual(['Virgen de Guadalupe', 'Navidad']);
    const a2 = await as(t, x.adminA).get(`/sites/${x.siteA2.id}/holidays?year=2026`).expect(200);
    expect(a2.body.items.map((h: { name: string }) => h.name)).toEqual(['Navidad']);
  });

  it('un festivo cambia el día: sin retardo, y en el calendario cuenta como festivo trabajado', async () => {
    setNow('2026-12-12T15:00:00Z'); // sábado 12, 09:00, festivo de la sede
    expect((await checkIn(dani)).body).toMatchObject({ late: false });
    const p = await panel(x.leaderA1).expect(200);
    expect(p.body.day).toEqual({
      dayType: 'holiday',
      sunday: false,
      holidayName: 'Virgen de Guadalupe',
      workday: false,
    });
    setNow('2026-12-26T15:00:00Z');
    const cal = await as(t, x.leaderA1)
      .get(`/sites/${site()}/attendance/users/${dani.userId}/calendar?month=2026-12`)
      .expect(200);
    const byDate = Object.fromEntries(cal.body.days.map((d: { date: string }) => [d.date, d]));
    // Quedó sin salida: el 26 ya es salida pendiente.
    expect(byDate['2026-12-12']).toMatchObject({ dayType: 'holiday', status: 'pending-exit' });
    expect(byDate['2026-12-13']).toMatchObject({ dayType: 'rest', sunday: true, status: 'day-off' });
    expect(byDate['2026-12-25']).toMatchObject({
      dayType: 'holiday',
      status: 'day-off',
      holidayName: 'Navidad',
    });
    expect(byDate['2026-12-14']).toMatchObject({ dayType: 'ordinary', status: 'no-record' });
    expect(cal.body.totals).toMatchObject({ holidaysWorked: 1, late: 1 });
  });

  it('los descansos son de la sede, no se asume sábado y domingo', async () => {
    await as(t, x.adminA)
      .put(`/sites/${site()}`, { ...A1, restDays: [6] })
      .expect(200);
    const cal = await calendar(beto).expect(200);
    const byDate = Object.fromEntries(cal.body.days.map((d: { date: string }) => [d.date, d]));
    expect(byDate['2026-12-05']).toMatchObject({ dayType: 'rest', sunday: false });
    expect(byDate['2026-12-06']).toMatchObject({ dayType: 'sunday', sunday: true, workday: true });
    expect(byDate['2026-12-06'].record).not.toBeNull();
    expect(cal.body.totals.sundaysWorked).toBe(1);
    const s = await as(t, x.adminA).get(`/sites/${site()}`).expect(200);
    expect(s.body).toMatchObject({ restDays: [6], lateToleranceMin: 10 });
    await as(t, x.adminA)
      .put(`/sites/${site()}`, { ...A1, restDays: [0, 1, 2, 3, 4, 5, 6] })
      .expect(400);
    await as(t, x.adminA)
      .put(`/sites/${site()}`, { ...A1, restDays: [0, 0] })
      .expect(400);
    await as(t, x.adminA).put(`/sites/${site()}`, A1).expect(200);
  });

  it('el líder no administra festivos; otra compañía no los ve; borrar queda auditado', async () => {
    await as(t, x.leaderA1)
      .post(`/sites/${site()}/holidays`, { date: '2026-12-31', name: 'Fin de año' })
      .expect(403);
    await as(t, x.adminB).get(`/companies/${x.companyA.id}/holidays`).expect(403);
    const b = await as(t, x.adminB).get(`/companies/${x.companyB.id}/holidays`).expect(200);
    expect(b.body.items).toEqual([]);
    const all = await as(t, x.adminA).get(`/companies/${x.companyA.id}/holidays?year=2026`).expect(200);
    const navidad = all.body.items.find((h: { name: string }) => h.name === 'Navidad');
    await request(t.server)
      .delete(`/companies/${x.companyB.id}/holidays/${navidad.id}`)
      .set('Cookie', x.adminB.cookie)
      .set('Origin', 'http://localhost:5173')
      .expect(404);
    await request(t.server)
      .delete(`/companies/${x.companyA.id}/holidays/${navidad.id}`)
      .set('Cookie', x.adminA.cookie)
      .set('Origin', 'http://localhost:5173')
      .expect(204);
    expect(await auditOf(x.companyA.id, 'holiday.delete')).toEqual([
      expect.objectContaining({ actor_user_id: x.adminA.userId }),
    ]);
  });
});

describe('Exportación y OpenAPI', () => {
  it('el Excel trae tipo de día, retardos, horas extra y justificaciones', async () => {
    const res = await binary(
      as(t, x.adminA).get(`/sites/${site()}/attendance/export?from=2026-12-01&to=2026-12-31`),
    ).expect(200);
    const text = xlsxText(res.body as Buffer);
    for (const s of [
      'Tipo de día',
      'Retardo',
      'Horas extra autorizadas',
      'Tiempo no autorizado (horas)',
      'Retardo (aprobada)',
      'Festivo: Virgen de Guadalupe',
      'Descansos trabajados',
    ]) {
      expect(text, s).toContain(s);
    }
  });

  it('OpenAPI documenta las rutas nuevas', () => {
    const paths = Object.keys((t.openapi as { paths: Record<string, unknown> }).paths);
    for (const p of [
      '/sites/{siteId}/privacy-notice',
      '/sites/{siteId}/privacy-notice/accept',
      '/sites/{siteId}/attendance/late-check-in',
      '/sites/{siteId}/justifications',
      '/sites/{siteId}/justifications/me',
      '/sites/{siteId}/justifications/{id}/approve',
      '/sites/{siteId}/justifications/{id}/reject',
      '/sites/{siteId}/overtime',
      '/sites/{siteId}/overtime/{id}/close',
      '/companies/{companyId}/holidays',
      '/companies/{companyId}/holidays/statutory',
      '/companies/{companyId}/holidays/{id}',
      '/sites/{siteId}/holidays',
    ]) {
      expect(paths, p).toContain(p);
    }
  });
});
