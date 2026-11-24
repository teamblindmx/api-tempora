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
  startApp,
  type Tenants,
  type TestApp,
  type TestUser,
} from './helpers.js';

/**
 * Semana 7 (ADR 0015): corrección de horas, revisión de jornadas "por revisar" y avisos al líder.
 * Sede A1: 08:00 a 17:00 en CDMX (UTC-6), tolerancia de 10 minutos. El 8 de diciembre de 2026 es
 * martes. Las acciones del líder ocurren por omisión el 9 a mediodía.
 */

let t: TestApp;
let x: Tenants;
let clock: Clock;
let ana: TestUser;
let beto: TestUser;
let carla: TestUser;
let dani: TestUser;
let encargado: TestUser;

const SITE = { latitude: 20.676667, longitude: -103.347222 };
const NEAR = { latitude: 20.6768, longitude: -103.3474, accuracyM: 12 };
const FAR = { latitude: 20.7, longitude: -103.347222, accuracyM: 10 };
const A1 = { ...SITE, radiusM: 300, shiftStart: '08:00', shiftEnd: '17:00' };

/** Jornadas del 8 de diciembre, por persona. */
const rec: Record<string, string> = {};

const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};
const site = () => x.siteA1.id;
const newCode = async () =>
  (await as(t, x.leaderA1).post(`/sites/${site()}/daily-code`, { ttlMinutes: 30 }).expect(201)).body
    .code as string;
const checkIn = async (user: TestUser, location: object | null) =>
  as(t, user)
    .post(`/sites/${site()}/attendance/check-in`, { code: await newCode(), location })
    .expect(201);
const correct = (by: TestUser, id: string, body: object, siteId = site()) =>
  as(t, by).post(`/sites/${siteId}/attendance/records/${id}/correct`, body);
const review = (by: TestUser, id: string, body: object = {}) =>
  as(t, by).post(`/sites/${site()}/attendance/records/${id}/review`, body);
const notices = (by: TestUser, status = 'open') => as(t, by).get(`/sites/${site()}/notices?status=${status}`);
const queue = (by: TestUser) =>
  as(t, by).get(`/sites/${site()}/attendance/review?from=2026-12-01&to=2026-12-31`);
type NoticeBody = { attendanceRecordId: string | null; justificationId: string | null; kind: string };
const noticesOf = (body: { items: NoticeBody[] }, recordId: string) =>
  body.items.filter((n) => n.attendanceRecordId === recordId && n.kind === 'attendance-review');

async function auditOf(companyId: string, action: string) {
  const c = new pg.Client({ connectionString: inject('env')['DATABASE_URL'] });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
    const { rows } = await c.query<{
      actor_user_id: string;
      target_id: string;
      reason: string | null;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, target_id, reason, before, after FROM app.audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );
    return rows;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
  clock = t.app.get(Clock);
  const assign = (u: TestUser, key: RoleKey) =>
    t.auth.axeda.assignments.assign(x.owner.actor, {
      userId: u.userId,
      roleId: x.roleId(key),
      scope: { type: 'site', id: x.siteA1.id },
    });
  ana = await createUser(t, 'Ana', { ip: '10.2.0.1' });
  beto = await createUser(t, 'Beto', { ip: '10.2.0.2' });
  carla = await createUser(t, 'Carla', { ip: '10.2.0.3' });
  dani = await createUser(t, 'Dani', { ip: '10.2.0.4' });
  encargado = await createUser(t, 'encargado', { ip: '10.2.0.5' });
  for (const u of [ana, beto, carla, dani]) await assign(u, 'worker');
  await assign(encargado, 'acting-leader');
  await as(t, x.adminA).put(`/sites/${x.siteA1.id}`, A1).expect(200);
  await as(t, x.adminA).put(`/sites/${x.siteA2.id}`, SITE).expect(200);
  await acceptPrivacy(t, x.siteA1.id, ana, beto, carla, dani, x.leaderA1);

  // Martes 8: Ana sin ubicación, Beto lejos de la sede, Carla con retardo, el líder sin ubicación.
  setNow('2026-12-08T14:00:00Z');
  rec['ana'] = (await checkIn(ana, null)).body.id;
  rec['leader'] = (await checkIn(x.leaderA1, null)).body.id;
  setNow('2026-12-08T14:02:00Z');
  rec['beto'] = (await checkIn(beto, FAR)).body.id;
  setNow('2026-12-08T14:25:00Z');
  rec['carla'] = (await checkIn(carla, NEAR)).body.id;
  setNow('2026-12-08T23:00:00Z');
  await as(t, carla).post(`/sites/${site()}/attendance/check-out`, { location: NEAR }).expect(200);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => setNow('2026-12-09T18:00:00Z'));

describe('Avisos al líder (regla 8)', () => {
  it('una entrada por revisar genera un aviso para la sede', async () => {
    const res = await notices(x.leaderA1).expect(200);
    const [n] = noticesOf(res.body, rec['ana']!);
    expect(n).toMatchObject({
      kind: 'attendance-review',
      person: { userId: ana.userId, name: 'Ana' },
      workDate: '2026-12-08',
      detail: ['entry:no-location'],
      readAt: null,
    });
    expect(noticesOf(res.body, rec['beto']!)[0]).toMatchObject({ detail: ['entry:outside-radius'] });
    // Carla marcó cerca: no hay nada que revisar ni que avisar.
    expect(noticesOf(res.body, rec['carla']!)).toEqual([]);
    expect(res.body.open).toBe(res.body.items.length);
  });

  it('la salida que agrega motivos actualiza el mismo aviso (uno pendiente por jornada)', async () => {
    setNow('2026-12-09T00:30:00Z'); // 18:30 del 8, sin ubicación
    const out = await as(t, ana)
      .post(`/sites/${site()}/attendance/check-out`, { location: null })
      .expect(200);
    expect(out.body.reviewReasons).toEqual(['entry:no-location', 'exit:no-location', 'exit:off-schedule']);
    const list = noticesOf((await notices(x.leaderA1).expect(200)).body, rec['ana']!);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('attendance-review');
    expect((list[0] as unknown as { detail: string[] }).detail).toEqual([
      'entry:no-location',
      'exit:no-location',
      'exit:off-schedule',
    ]);
  });

  it('el encargado ve los avisos; el trabajador y otra compañía no', async () => {
    await notices(encargado).expect(200);
    await notices(ana).expect(403);
    await notices(x.adminB).expect(403);
  });

  it('una justificación nueva avisa, y al resolverla el aviso queda atendido', async () => {
    const j = await as(t, dani)
      .post(`/sites/${site()}/justifications`, {
        workDate: '2026-12-08',
        kind: 'absence',
        reason: 'Tuve cita en el IMSS',
      })
      .expect(201);
    const open = (await notices(x.leaderA1).expect(200)).body.items as (NoticeBody & { detail: string[] })[];
    expect(open.find((n) => n.justificationId === j.body.id)).toMatchObject({
      kind: 'justification',
      detail: ['absence'],
    });
    await as(t, x.leaderA1).post(`/sites/${site()}/justifications/${j.body.id}/approve`, {}).expect(200);
    const after = (await notices(x.leaderA1).expect(200)).body.items as NoticeBody[];
    expect(after.find((n) => n.justificationId === j.body.id)).toBeUndefined();
    const all = (await notices(x.leaderA1, 'all').expect(200)).body.items as (NoticeBody & {
      readBy: string;
    })[];
    expect(all.find((n) => n.justificationId === j.body.id)).toMatchObject({ readBy: x.leaderA1.userId });
  });

  it('"ya lo vi" quita el aviso para todos, pero la jornada sigue por revisar', async () => {
    const [n] = noticesOf((await notices(x.leaderA1).expect(200)).body, rec['beto']!) as unknown as {
      id: string;
    }[];
    const read = await as(t, encargado).post(`/sites/${site()}/notices/${n!.id}/read`).expect(200);
    expect(read.body).toMatchObject({ readBy: encargado.userId, readAt: '2026-12-09T18:00:00.000Z' });
    setNow('2026-12-09T18:05:00Z');
    const again = await as(t, x.leaderA1).post(`/sites/${site()}/notices/${n!.id}/read`).expect(200);
    expect(again.body.readBy).toBe(encargado.userId);
    expect(noticesOf((await notices(x.leaderA1).expect(200)).body, rec['beto']!)).toEqual([]);
    const q = await queue(x.leaderA1).expect(200);
    expect(q.body.items.map((i: { record: { id: string } }) => i.record.id)).toContain(rec['beto']);
    const missing = await as(t, x.leaderA1).post(
      `/sites/${site()}/notices/00000000-0000-4000-8000-000000000000/read`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TEMPORA_NOTICE_NOT_FOUND');
  });
});

describe('Revisión de jornadas "por revisar"', () => {
  it('la lista trae solo lo pendiente, con la persona y sus motivos', async () => {
    const q = await queue(encargado).expect(200);
    expect(q.body).toMatchObject({ siteId: site(), from: '2026-12-01', to: '2026-12-31' });
    const ids = q.body.items.map((i: { record: { id: string } }) => i.record.id);
    expect(ids).toEqual(expect.arrayContaining([rec['ana'], rec['beto'], rec['leader']]));
    expect(ids).not.toContain(rec['carla']);
    const beto0 = q.body.items.find((i: { record: { id: string } }) => i.record.id === rec['beto']);
    expect(beto0).toMatchObject({ person: { name: 'Beto' }, pendingReasons: ['entry:outside-radius'] });
    await queue(ana).expect(403);
  });

  it('el líder revisa con comentario: deja de estar por revisar y su aviso se atiende', async () => {
    const res = await review(x.leaderA1, rec['ana']!, { comment: 'Sin señal en la nave 2' }).expect(200);
    expect(res.body).toMatchObject({
      needsReview: false,
      reviewReasons: ['entry:no-location', 'exit:no-location', 'exit:off-schedule'],
      reviewedReasons: ['entry:no-location', 'exit:no-location', 'exit:off-schedule'],
      reviewedBy: x.leaderA1.userId,
      reviewedAt: '2026-12-09T18:00:00.000Z',
      reviewComment: 'Sin señal en la nave 2',
    });
    expect(noticesOf((await notices(x.leaderA1).expect(200)).body, rec['ana']!)).toEqual([]);
    const q = await queue(x.leaderA1).expect(200);
    expect(q.body.items.map((i: { record: { id: string } }) => i.record.id)).not.toContain(rec['ana']);
    const panel = await as(t, x.leaderA1).get(`/sites/${site()}/attendance/day?date=2026-12-08`).expect(200);
    const anaEntry = panel.body.entries.find(
      (e: { person: { userId: string } }) => e.person.userId === ana.userId,
    );
    expect(anaEntry.record.needsReview).toBe(false);
    const audit = (await auditOf(x.companyA.id, 'attendance.review')).filter(
      (a) => a.target_id === rec['ana'],
    );
    expect(audit).toEqual([
      expect.objectContaining({ actor_user_id: x.leaderA1.userId, reason: 'Sin señal en la nave 2' }),
    ]);
  });

  it('no se revisa dos veces, ni lo propio, ni sin permiso', async () => {
    const twice = await review(x.leaderA1, rec['ana']!);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('TEMPORA_NOTHING_TO_REVIEW');
    const self = await review(x.leaderA1, rec['leader']!);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('TEMPORA_REVIEW_SELF');
    await review(encargado, rec['beto']!).expect(403);
    await review(beto, rec['beto']!).expect(403);
    // El administrador sí revisa la del líder.
    await review(x.adminA, rec['leader']!).expect(200);
  });
});

describe('Corrección de horas (regla 13)', () => {
  it('corregir la entrada vuelve a decidir el retardo y queda en el historial', async () => {
    const before = await as(t, x.leaderA1)
      .get(`/sites/${site()}/attendance/records/${rec['carla']}`)
      .expect(200);
    expect(before.body.record).toMatchObject({ late: true, lateMinutes: 25, correctedAt: null });
    expect(before.body.corrections).toEqual([]);

    const res = await correct(x.leaderA1, rec['carla']!, {
      checkInAt: '2026-12-08T08:05:00-06:00',
      comment: 'Llegó 08:05, el código tardó en salir',
    }).expect(200);
    expect(res.body).toMatchObject({
      checkInAt: '2026-12-08T14:05:00.000Z',
      late: false,
      lateMinutes: 5,
      checkInSource: 'self',
      correctedBy: x.leaderA1.userId,
      correctedAt: '2026-12-09T18:00:00.000Z',
      workedMinutes: 535,
    });
    const detail = await as(t, encargado)
      .get(`/sites/${site()}/attendance/records/${rec['carla']}`)
      .expect(200);
    expect(detail.body.person).toMatchObject({ name: 'Carla' });
    expect(detail.body.corrections).toEqual([
      expect.objectContaining({
        correctedBy: x.leaderA1.userId,
        checkInBefore: '2026-12-08T14:25:00.000Z',
        checkInAfter: '2026-12-08T14:05:00.000Z',
        checkOutBefore: '2026-12-08T23:00:00.000Z',
        checkOutAfter: '2026-12-08T23:00:00.000Z',
        comment: 'Llegó 08:05, el código tardó en salir',
      }),
    ]);
    const [audit] = (await auditOf(x.companyA.id, 'attendance.correct')).filter(
      (a) => a.target_id === rec['carla'],
    );
    expect(audit).toMatchObject({
      actor_user_id: x.leaderA1.userId,
      reason: 'Llegó 08:05, el código tardó en salir',
      before: { checkInAt: '2026-12-08T14:25:00.000Z', late: true },
      after: { checkInAt: '2026-12-08T14:05:00.000Z', late: false },
    });
  });

  it('corregir la salida vuelve a decidir "fuera de horario"; si vuelve a estarlo, avisa otra vez', async () => {
    const fixed = await correct(x.leaderA1, rec['ana']!, {
      checkOutAt: '2026-12-08T23:10:00Z',
      comment: 'Salió 17:10, marcó al llegar a casa',
    }).expect(200);
    expect(fixed.body).toMatchObject({
      checkOutKind: 'regular',
      reviewReasons: ['entry:no-location', 'exit:no-location'],
      reviewedReasons: ['entry:no-location', 'exit:no-location'],
      needsReview: false,
    });
    expect(noticesOf((await notices(x.leaderA1).expect(200)).body, rec['ana']!)).toEqual([]);

    setNow('2026-12-09T18:10:00Z');
    const late = await correct(x.leaderA1, rec['ana']!, {
      checkOutAt: '2026-12-09T01:00:00Z',
      comment: 'Me equivoqué: salió 19:00',
    }).expect(200);
    expect(late.body).toMatchObject({
      reviewReasons: ['entry:no-location', 'exit:no-location', 'exit:off-schedule'],
      needsReview: true,
    });
    const [n] = noticesOf((await notices(x.leaderA1).expect(200)).body, rec['ana']!) as unknown as {
      detail: string[];
    }[];
    expect(n!.detail).toEqual(['exit:off-schedule']);
    const detail = await as(t, x.leaderA1)
      .get(`/sites/${site()}/attendance/records/${rec['ana']}`)
      .expect(200);
    expect(detail.body.corrections).toHaveLength(2);
  });

  it('una salida corregida antes de tiempo queda como anticipada, con el comentario como motivo', async () => {
    const res = await correct(x.adminA, rec['carla']!, {
      checkOutAt: '2026-12-08T21:00:00Z',
      comment: 'Salió a las 15:00 por permiso',
    }).expect(200);
    expect(res.body).toMatchObject({
      checkOutKind: 'early',
      checkOutReason: 'Salió a las 15:00 por permiso',
    });
  });

  it('rechaza correcciones imposibles con un código estable', async () => {
    const cases: [string, object][] = [
      [rec['beto']!, { checkOutAt: '2026-12-08T23:00:00Z', comment: 'Aún no tiene salida' }],
      [rec['carla']!, { checkInAt: '2026-12-09T19:00:00Z', comment: 'Hora del futuro' }],
      [rec['carla']!, { checkInAt: '2026-12-07T14:00:00Z', comment: 'Otro día distinto' }],
      [rec['carla']!, { checkOutAt: '2026-12-08T13:00:00Z', comment: 'Antes de la entrada' }],
      [rec['carla']!, { checkInAt: '2026-12-08T14:05:00Z', comment: 'La misma hora de antes' }],
    ];
    for (const [id, body] of cases) {
      const res = await correct(x.leaderA1, id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('TEMPORA_CORRECTION_INVALID');
    }
    setNow('2027-01-15T18:00:00Z');
    const old = await correct(x.leaderA1, rec['carla']!, {
      checkInAt: '2026-12-08T14:00:00Z',
      comment: 'Demasiado tarde para esto',
    });
    expect(old.status).toBe(422);
    expect(old.body.message).toMatch(/31 días/);
  });

  it('valida el cuerpo: alguna hora y un comentario', async () => {
    await correct(x.leaderA1, rec['carla']!, { comment: 'Sin horas que corregir' }).expect(400);
    await correct(x.leaderA1, rec['carla']!, { checkInAt: '2026-12-08T14:00:00Z', comment: 'ok' }).expect(
      400,
    );
  });

  it('nadie corrige lo suyo; el encargado y el trabajador no corrigen; otra sede no la encuentra', async () => {
    const self = await correct(x.leaderA1, rec['leader']!, {
      checkInAt: '2026-12-08T13:55:00Z',
      comment: 'Quiero mi entrada antes',
    });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('TEMPORA_CORRECTION_SELF');
    const body = { checkInAt: '2026-12-08T14:00:00Z', comment: 'Intento sin permiso' };
    await correct(encargado, rec['beto']!, body).expect(403);
    await correct(beto, rec['beto']!, body).expect(403);
    await correct(x.adminB, rec['beto']!, body).expect(403);
    const otherSite = await correct(x.adminA, rec['beto']!, body, x.siteA2.id);
    expect(otherSite.status).toBe(404);
    expect(otherSite.body.code).toBe('TEMPORA_RECORD_NOT_FOUND');
  });
});

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('Exportación y OpenAPI', () => {
  it('el Excel separa lo pendiente de lo revisado y marca las corregidas', async () => {
    const res = await binary(
      as(t, x.adminA).get(`/sites/${site()}/attendance/export?from=2026-12-01&to=2026-12-31`),
    ).expect(200);
    const text = Object.entries(unzipSync(new Uint8Array(res.body as Buffer)))
      .filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml'))
      .map(([, data]) => strFromU8(data))
      .join('\n');
    for (const s of ['Revisado', 'Corregida', 'Sin señal en la nave 2', 'Entrada fuera del radio']) {
      expect(text, s).toContain(s);
    }
  });

  it('OpenAPI documenta las rutas nuevas', () => {
    const paths = Object.keys((t.openapi as { paths: Record<string, unknown> }).paths);
    for (const p of [
      '/sites/{siteId}/attendance/review',
      '/sites/{siteId}/attendance/records/{id}',
      '/sites/{siteId}/attendance/records/{id}/correct',
      '/sites/{siteId}/attendance/records/{id}/review',
      '/sites/{siteId}/notices',
      '/sites/{siteId}/notices/{id}/read',
    ]) {
      expect(paths, p).toContain(p);
    }
  });
});
