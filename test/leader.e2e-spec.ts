import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Site } from '@teamblind/axeda-core';
import { Clock } from '../src/common/clock.js';
import type { RoleKey } from '../src/auth/permissions.js';
import {
  acceptPrivacy,
  as,
  createTenants,
  createUser,
  startApp,
  type Tenants,
  type TestApp,
  type TestUser,
} from './helpers.js';

let t: TestApp;
let x: Tenants;
let clock: Clock;
/** Más gente: otro trabajador y un encargado en A1, un trabajador en A2 y otro en B1. */
let ana: TestUser;
let encargado: TestUser;
let workerA2: TestUser;
let workerB1: TestUser;
/** Una sede de A que cuelga de un negocio, con su administrador de negocio y un trabajador. */
let siteN1: Site;
let businessAdmin: TestUser;
let workerN1: TestUser;

const SITE = { latitude: 20.676667, longitude: -103.347222 };
const NEAR = { latitude: 20.6768, longitude: -103.3474, accuracyM: 12 };
const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};

const day = (by: TestUser, date?: string, siteId = x.siteA1.id) =>
  as(t, by).get(`/sites/${siteId}/attendance/day${date ? `?date=${date}` : ''}`);
const manualIn = (by: TestUser, body: object, siteId = x.siteA1.id) =>
  as(t, by).post(`/sites/${siteId}/attendance/manual/check-in`, body);
const manualOut = (by: TestUser, body: object, siteId = x.siteA1.id) =>
  as(t, by).post(`/sites/${siteId}/attendance/manual/check-out`, body);
const selfIn = async (user: TestUser, siteId = x.siteA1.id, leader = x.leaderA1) => {
  const code = (await as(t, leader).post(`/sites/${siteId}/daily-code`).expect(201)).body.code as string;
  return as(t, user).post(`/sites/${siteId}/attendance/check-in`, { code, location: NEAR }).expect(201);
};

/** Todo el texto de un .xlsx (celdas de todas las hojas), para buscar nombres. */
function xlsxText(body: Buffer): string {
  const files = unzipSync(new Uint8Array(body));
  return Object.entries(files)
    .filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml'))
    .map(([, data]) => strFromU8(data))
    .join('\n');
}
const pendingDates = (p: { body: { pendingExits: { record: { workDate: string } }[] } }) =>
  p.body.pendingExits.map((e) => e.record.workDate);
const exportOf = (by: TestUser, path: string) => binary(as(t, by).get(path));

/** Auditoría de una compañía, leída como la API (rol tempora_app, con la compañía fijada para RLS). */
async function auditOf(companyId: string, action: string) {
  const c = new pg.Client({ connectionString: inject('env')['DATABASE_URL'] });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    const { rows } = await c.query<{ action: string; actor_user_id: string; reason: string; after: unknown }>(
      `SELECT action, actor_user_id, reason, after FROM app.audit_log WHERE action LIKE $1 ORDER BY id`,
      [action],
    );
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

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
  clock = t.app.get(Clock);
  const { axeda } = t.auth;
  const assign = (u: TestUser, key: RoleKey, scope: { type: 'site' | 'business'; id: string }) =>
    axeda.assignments.assign(x.owner.actor, { userId: u.userId, roleId: x.roleId(key), scope });

  ana = await createUser(t, 'Ana', { ip: '10.0.0.1' });
  encargado = await createUser(t, 'encargado', { ip: '10.0.0.2' });
  workerA2 = await createUser(t, 'workerA2', { ip: '10.0.0.3' });
  workerB1 = await createUser(t, 'workerB1', { ip: '10.0.0.4' });
  await assign(ana, 'worker', { type: 'site', id: x.siteA1.id });
  await assign(encargado, 'acting-leader', { type: 'site', id: x.siteA1.id });
  await assign(workerA2, 'worker', { type: 'site', id: x.siteA2.id });
  await assign(workerB1, 'worker', { type: 'site', id: x.siteB1.id });

  const business = await axeda.businesses.create(x.owner.actor, x.companyA.id, {
    slug: 'norte',
    name: 'Norte',
  });
  siteN1 = await axeda.sites.create(x.owner.actor, x.companyA.id, {
    slug: 'chi',
    name: 'Chihuahua',
    businessId: business.id,
  });
  businessAdmin = await createUser(t, 'businessAdmin', { ip: '10.0.0.5' });
  workerN1 = await createUser(t, 'workerN1', { ip: '10.0.0.6' });
  await assign(businessAdmin, 'business-admin', { type: 'business', id: business.id });
  await assign(workerN1, 'worker', { type: 'site', id: siteN1.id });

  await as(t, x.adminA)
    .put(`/sites/${x.siteA1.id}`, { ...SITE, radiusM: 300, shiftStart: '08:00', shiftEnd: '17:00' })
    .expect(200);
  await as(t, x.adminA).put(`/sites/${x.siteA2.id}`, SITE).expect(200);
  await as(t, x.adminA).put(`/sites/${siteN1.id}`, SITE).expect(200);
  await as(t, x.adminB).put(`/sites/${x.siteB1.id}`, SITE).expect(200);
  await acceptPrivacy(t, x.siteA1.id, x.workerA1, x.leaderA1, ana);
  await acceptPrivacy(t, x.siteA2.id, workerA2);
  await acceptPrivacy(t, x.siteB1.id, workerB1);
  await acceptPrivacy(t, siteN1.id, workerN1);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => setNow('2026-12-01T15:00:00Z'));

describe('Panel del líder', () => {
  it('muestra quién llegó y quién falta en la sede, primero quien falta', async () => {
    setNow('2026-12-01T14:10:00Z'); // 08:10 en Guadalajara
    await selfIn(x.workerA1);
    const r = await day(x.leaderA1).expect(200);
    expect(r.body).toMatchObject({
      siteId: x.siteA1.id,
      date: '2026-12-01',
      today: '2026-12-01',
      timezone: 'America/Mexico_City',
      shift: { start: '08:00', end: '17:00' },
    });
    const byUser = Object.fromEntries(
      (r.body.entries as { person: { userId: string } }[]).map((e) => [e.person.userId, e]),
    );
    // Plantilla: quien marca asistencia en A1 (trabajadores y líder); el encargado no marca.
    expect(Object.keys(byUser).toSorted()).toEqual(
      [x.leaderA1.userId, x.workerA1.userId, ana.userId].toSorted(),
    );
    expect(byUser[ana.userId]).toMatchObject({ status: 'missing', record: null, onRoster: true });
    expect(byUser[x.workerA1.userId]).toMatchObject({
      status: 'open',
      minutesAfterStart: 10,
      manual: false,
      person: { name: 'workerA1', email: x.workerA1.email },
      record: { checkInSource: 'self', workedMinutes: null },
    });
    expect(r.body.entries[0].status).toBe('missing');
    expect(r.body.summary).toMatchObject({ expected: 3, arrived: 1, missing: 2, open: 1 });
  });

  it('otro día y días pasados; un día futuro es 422', async () => {
    const past = await day(x.leaderA1, '2026-11-30').expect(200);
    expect(past.body.summary).toMatchObject({ expected: 3, arrived: 0, missing: 3 });
    expect((await day(x.leaderA1, '2026-12-02').expect(422)).body.code).toBe('TEMPORA_DATE_IN_FUTURE');
    await day(x.leaderA1, '2026-13-01').expect(400);
  });

  it('el encargado también lo ve; el trabajador, otra sede u otra compañía, no', async () => {
    await day(encargado).expect(200);
    await day(x.workerA1).expect(403);
    await day(x.leaderA1, undefined, x.siteA2.id).expect(403);
    await day(x.leaderA1, undefined, x.siteB1.id).expect(403);
    await day(x.adminB).expect(403);
    await day(x.owner).expect(403);
    await request(t.server).get(`/sites/${x.siteA1.id}/attendance/day`).expect(401);
  });

  it('nunca muestra gente ni jornadas de otra compañía', async () => {
    setNow('2026-12-01T15:30:00Z');
    await selfIn(workerB1, x.siteB1.id, x.adminB);
    const a = await day(x.adminA).expect(200);
    const ids = JSON.stringify(a.body);
    expect(ids).not.toContain(workerB1.userId);
    const b = await day(x.adminB, undefined, x.siteB1.id).expect(200);
    expect(b.body.entries.map((e: { person: { userId: string } }) => e.person.userId)).toEqual([
      workerB1.userId,
    ]);
  });
});

describe('Marcado manual', () => {
  it('el líder registra la entrada de quien no pudo marcar: sin código, con autor y comentario', async () => {
    setNow('2026-12-02T14:20:00Z');
    const r = await manualIn(x.leaderA1, {
      userId: ana.userId,
      comment: 'Llegó sin batería en el teléfono',
    }).expect(201);
    expect(r.body).toMatchObject({
      userId: ana.userId,
      workDate: '2026-12-02',
      checkInAt: '2026-12-02T14:20:00.000Z',
      checkInSource: 'manual',
      checkInBy: x.leaderA1.userId,
      checkInComment: 'Llegó sin batería en el teléfono',
      status: 'open',
      needsReview: false,
    });
    const panel = await day(x.leaderA1).expect(200);
    const e = panel.body.entries.find((y: { person: { userId: string } }) => y.person.userId === ana.userId);
    expect(e).toMatchObject({ status: 'open', manual: true });
    expect(panel.body.summary.manual).toBe(1);

    // La trabajadora lo ve en su jornada y ya no puede marcar entrada ese día.
    const mine = await as(t, ana).get(`/sites/${x.siteA1.id}/attendance/me`).expect(200);
    expect(mine.body.record).toMatchObject({ checkInSource: 'manual', checkInBy: x.leaderA1.userId });
    expect(
      (await manualIn(x.leaderA1, { userId: ana.userId, comment: 'Otra vez' }).expect(409)).body.code,
    ).toBe('TEMPORA_ALREADY_CHECKED_IN');
  });

  it('el líder registra la salida; el trabajador puede salir por su cuenta si su jornada sigue abierta', async () => {
    setNow('2026-12-02T23:05:00Z');
    const r = await manualOut(x.leaderA1, { userId: ana.userId, comment: 'Salió con el supervisor' }).expect(
      200,
    );
    expect(r.body).toMatchObject({
      status: 'closed',
      checkOutAt: '2026-12-02T23:05:00.000Z',
      checkOutKind: 'regular',
      checkOutSource: 'manual',
      checkOutBy: x.leaderA1.userId,
      checkOutComment: 'Salió con el supervisor',
      workedMinutes: 525,
    });
    expect(
      (await manualOut(x.leaderA1, { userId: ana.userId, comment: 'De nuevo' }).expect(409)).body.code,
    ).toBe('TEMPORA_NOT_CHECKED_IN');
  });

  it('una salida manual antes de la ventana queda anticipada, con el comentario como motivo', async () => {
    setNow('2026-12-03T14:00:00Z');
    await manualIn(x.leaderA1, { userId: ana.userId, comment: 'Sin señal en la entrada' }).expect(201);
    setNow('2026-12-03T19:00:00Z');
    const r = await manualOut(x.leaderA1, { userId: ana.userId, comment: 'Se fue al IMSS' }).expect(200);
    expect(r.body).toMatchObject({ checkOutKind: 'early', checkOutReason: 'Se fue al IMSS' });
  });

  it('cierra una salida pendiente de otro día solo con la hora real', async () => {
    setNow('2026-12-04T14:00:00Z');
    await selfIn(x.workerA1);
    setNow('2026-12-05T15:00:00Z');
    const panel = await day(x.leaderA1).expect(200);
    // La del 1 de diciembre también quedó sin salida (prueba del panel).
    expect(pendingDates(panel)).toEqual(['2026-12-04', '2026-12-01']);
    expect(panel.body.pendingExits[0]).toMatchObject({
      status: 'pending-exit',
      person: { userId: x.workerA1.userId },
    });
    const noTime = await manualOut(x.leaderA1, {
      userId: x.workerA1.userId,
      comment: 'Olvidó marcar',
    }).expect(422);
    expect(noTime.body.code).toBe('TEMPORA_MANUAL_TIME_REQUIRED');
    const tooLong = await manualOut(x.leaderA1, {
      userId: x.workerA1.userId,
      comment: 'Olvidó marcar',
      at: '2026-12-05T14:30:00Z',
    }).expect(422);
    expect(tooLong.body.code).toBe('TEMPORA_MANUAL_TIME_INVALID');
    const r = await manualOut(x.leaderA1, {
      userId: x.workerA1.userId,
      comment: 'Olvidó marcar; salió a las 17:00 según el supervisor',
      at: '2026-12-04T17:00:00-06:00',
      workDate: '2026-12-04',
    }).expect(200);
    expect(r.body).toMatchObject({
      status: 'closed',
      checkOutAt: '2026-12-04T23:00:00.000Z',
      checkOutSource: 'manual',
      workedMinutes: 540,
    });
    expect(pendingDates(await day(x.leaderA1).expect(200))).toEqual(['2026-12-01']);
  });

  it('una entrada tardía registrada después lleva la hora real; nunca en el futuro ni de hace más de 7 días', async () => {
    setNow('2026-12-08T20:00:00Z');
    const r = await manualIn(encargado, {
      userId: x.workerA1.userId,
      comment: 'Entró a las 8:05, la app no abría',
      at: '2026-12-08T14:05:00Z',
    }).expect(201);
    expect(r.body).toMatchObject({ checkInAt: '2026-12-08T14:05:00.000Z', checkInBy: encargado.userId });
    for (const at of ['2026-12-08T20:01:00Z', '2026-11-30T14:00:00Z']) {
      const bad = await manualIn(x.leaderA1, { userId: ana.userId, comment: 'Prueba de hora', at }).expect(
        422,
      );
      expect(bad.body.code).toBe('TEMPORA_MANUAL_TIME_INVALID');
    }
  });

  it('el comentario es obligatorio y nadie se marca a sí mismo a mano', async () => {
    setNow('2026-12-09T14:00:00Z');
    await manualIn(x.leaderA1, { userId: ana.userId }).expect(400);
    await manualIn(x.leaderA1, { userId: ana.userId, comment: '   ' }).expect(400);
    const self = await manualIn(x.leaderA1, { userId: x.leaderA1.userId, comment: 'Me marco yo' }).expect(
      403,
    );
    expect(self.body.code).toBe('TEMPORA_MANUAL_SELF');
  });

  it('solo a gente asignada a la sede, y solo quien tiene el permiso en ella', async () => {
    setNow('2026-12-09T14:00:00Z');
    for (const userId of [workerA2.userId, workerB1.userId, 'no-existe']) {
      const r = await manualIn(x.leaderA1, { userId, comment: 'No es de mi sede' }).expect(422);
      expect(r.body.code).toBe('TEMPORA_NOT_SITE_EMPLOYEE');
    }
    await manualIn(x.workerA1, { userId: ana.userId, comment: 'Soy trabajador' }).expect(403);
    await manualIn(x.leaderA1, { userId: workerA2.userId, comment: 'Otra sede' }, x.siteA2.id).expect(403);
    await manualIn(x.adminB, { userId: ana.userId, comment: 'Otra compañía' }).expect(403);
    await manualIn(x.owner, { userId: ana.userId, comment: 'Dueño de la plataforma' }).expect(403);
  });

  it('cada marcado manual queda en la auditoría con el comentario y quién lo hizo', async () => {
    const audited = await auditOf(x.companyA.id, 'attendance.manual-%');
    expect(audited[0]).toMatchObject({
      action: 'attendance.manual-check-in',
      actor_user_id: x.leaderA1.userId,
      reason: 'Llegó sin batería en el teléfono',
    });
    expect(audited.map((a) => a.action)).toContain('attendance.manual-check-out');
    expect(audited.every((a) => a.reason.trim().length > 0)).toBe(true);
  });
});

describe('Calendario', () => {
  it('el trabajador ve su mes: días con jornada, sin registro y futuros, con totales', async () => {
    setNow('2026-12-10T15:00:00Z');
    const r = await as(t, x.workerA1)
      .get(`/sites/${x.siteA1.id}/attendance/me/calendar?month=2026-12`)
      .expect(200);
    expect(r.body).toMatchObject({ month: '2026-12', today: '2026-12-10', userId: x.workerA1.userId });
    expect(r.body.days).toHaveLength(31);
    const d = (date: string) => r.body.days.find((y: { date: string }) => y.date === date);
    expect(d('2026-12-01')).toMatchObject({ status: 'pending-exit' });
    expect(d('2026-12-04')).toMatchObject({
      status: 'closed',
      record: { checkOutSource: 'manual', workedMinutes: 540 },
    });
    expect(d('2026-12-08')).toMatchObject({ status: 'pending-exit', record: { checkInSource: 'manual' } });
    expect(d('2026-12-09')).toMatchObject({ status: 'no-record', record: null });
    expect(d('2026-12-11')).toMatchObject({ status: 'future', record: null });
    expect(r.body.totals).toMatchObject({ daysWorked: 3, workedMinutes: 540, manual: 2 });
  });

  it('sin mes, el actual; el líder ve el de un trabajador; nadie más', async () => {
    setNow('2026-12-10T15:00:00Z');
    const mine = await as(t, ana).get(`/sites/${x.siteA1.id}/attendance/me/calendar`).expect(200);
    expect(mine.body.month).toBe('2026-12');
    const leader = await as(t, x.leaderA1)
      .get(`/sites/${x.siteA1.id}/attendance/users/${ana.userId}/calendar?month=2026-12`)
      .expect(200);
    expect(leader.body.totals.daysWorked).toBe(mine.body.totals.daysWorked);
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/attendance/users/${ana.userId}/calendar`).expect(403);
    await as(t, x.adminB).get(`/sites/${x.siteA1.id}/attendance/users/${ana.userId}/calendar`).expect(403);
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/attendance/me/calendar?month=2026-1`).expect(400);
    // Por la sede de B no se ve nada de A, aunque se pida el mismo usuario.
    const fromB = await as(t, x.adminB)
      .get(`/sites/${x.siteB1.id}/attendance/users/${ana.userId}/calendar?month=2026-12`)
      .expect(200);
    expect(fromB.body.totals.daysWorked).toBe(0);
  });
});

describe('Exportación a Excel', () => {
  it('el administrador de compañía baja un .xlsx con jornadas y resumen, sin datos de otra compañía', async () => {
    setNow('2026-12-10T15:00:00Z');
    await selfIn(workerN1, siteN1.id, x.adminA);
    const r = await exportOf(
      x.adminA,
      `/companies/${x.companyA.id}/attendance/export?from=2026-12-01&to=2026-12-15`,
    ).expect(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="tempora-asistencia-2026-12-01-a-2026-12-15.xlsx"',
    );
    const text = xlsxText(r.body as Buffer);
    for (const s of [
      'Jornadas',
      'Resumen',
      'Guadalajara',
      'Chihuahua',
      'workerA1',
      'Ana',
      'Líder (manual)',
      'Se fue al IMSS',
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('workerB1');
    expect(text).not.toContain('Sonora');
  });

  it('por sede o por negocio, solo lo de ese lugar', async () => {
    const site = xlsxText(
      (
        await exportOf(
          x.adminA,
          `/sites/${x.siteA1.id}/attendance/export?from=2026-12-01&to=2026-12-15`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(site).toContain('Guadalajara');
    expect(site).not.toContain('Chihuahua');
    const biz = xlsxText(
      (
        await exportOf(
          businessAdmin,
          `/businesses/${siteN1.businessId}/attendance/export?from=2026-12-01&to=2026-12-15`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(biz).toContain('Chihuahua');
    expect(biz).not.toContain('Guadalajara');
  });

  it('el líder, el trabajador, otra compañía y el dueño de la plataforma no exportan', async () => {
    const q = '?from=2026-12-01&to=2026-12-15';
    await as(t, x.leaderA1).get(`/sites/${x.siteA1.id}/attendance/export${q}`).expect(403);
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/attendance/export${q}`).expect(403);
    await as(t, x.adminB).get(`/companies/${x.companyA.id}/attendance/export${q}`).expect(403);
    await as(t, businessAdmin).get(`/companies/${x.companyA.id}/attendance/export${q}`).expect(403);
    await as(t, x.owner).get(`/companies/${x.companyA.id}/attendance/export${q}`).expect(403);
  });

  it('el rango es obligatorio, en orden y de hasta 62 días; cada exportación se audita', async () => {
    const base = `/companies/${x.companyA.id}/attendance/export`;
    await as(t, x.adminA).get(base).expect(400);
    expect((await as(t, x.adminA).get(`${base}?from=2026-12-15&to=2026-12-01`).expect(422)).body.code).toBe(
      'TEMPORA_RANGE_INVALID',
    );
    await as(t, x.adminA).get(`${base}?from=2026-11-01&to=2027-01-02`).expect(422);
    const audited = await auditOf(x.companyA.id, 'attendance.export');
    expect(await auditOf(x.companyB.id, 'attendance.export')).toEqual([]);
    expect(audited.length).toBeGreaterThanOrEqual(3);
    expect(audited.map((a) => a.actor_user_id)).toContain(businessAdmin.userId);
  });

  it('OpenAPI documenta las rutas nuevas', () => {
    const paths = Object.keys(t.openapi['paths'] as object);
    for (const p of [
      '/sites/{siteId}/attendance/day',
      '/sites/{siteId}/attendance/manual/check-in',
      '/sites/{siteId}/attendance/manual/check-out',
      '/sites/{siteId}/attendance/me/calendar',
      '/sites/{siteId}/attendance/users/{userId}/calendar',
      '/sites/{siteId}/attendance/export',
      '/businesses/{businessId}/attendance/export',
      '/companies/{companyId}/attendance/export',
    ]) {
      expect(paths).toContain(p);
    }
  });
});
