import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Clock } from '../src/common/clock.js';
import { as, createTenants, startApp, type Tenants, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let x: Tenants;
let clock: Clock;

// Catedral de Guadalajara (la sede), un punto a ~25 m y el Teatro Degollado a ~500 m.
const SITE = { latitude: 20.676667, longitude: -103.347222 };
const NEAR = { latitude: 20.6768, longitude: -103.3474, accuracyM: 12 };
const FAR = { latitude: 20.676944, longitude: -103.3425 };

/** Fija la hora del servidor. CDMX es UTC-6: 08:00 locales son las 14:00Z. */
const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};

const newCode = async (siteId = x.siteA1.id, by: TestUser = x.leaderA1) =>
  (await as(t, by).post(`/sites/${siteId}/daily-code`).expect(201)).body.code as string;

const checkIn = (user: TestUser, body: object, siteId = x.siteA1.id) =>
  as(t, user).post(`/sites/${siteId}/attendance/check-in`, body);
const checkOut = (user: TestUser, body: object = {}, siteId = x.siteA1.id) =>
  as(t, user).post(`/sites/${siteId}/attendance/check-out`, body);

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
  clock = t.app.get(Clock);
  await as(t, x.adminA)
    .put(`/sites/${x.siteA1.id}`, { ...SITE, radiusM: 300, shiftStart: '08:00', shiftEnd: '17:00' })
    .expect(200);
  await as(t, x.adminB).put(`/sites/${x.siteB1.id}`, SITE).expect(200);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  setNow('2026-12-01T14:00:00Z');
  // El tope de intentos de entrada usa el reloj real: se vacía el almacén en memoria del throttler
  // para que cada prueba empiece en cero (campos internos de ThrottlerStorageService).
  const storage = t.app.get<unknown, Record<string, Map<string, unknown>>>(ThrottlerStorage);
  for (const k of ['_storage', 'hitExpirations']) storage[k]?.clear();
});

describe('Código diario', () => {
  it('el líder genera un código de 6 dígitos que dura 30 minutos, y lo puede volver a ver', async () => {
    const r = await as(t, x.leaderA1).post(`/sites/${x.siteA1.id}/daily-code`).expect(201);
    expect(r.body).toMatchObject({
      siteId: x.siteA1.id,
      code: expect.stringMatching(/^\d{6}$/),
      createdAt: '2026-12-01T14:00:00.000Z',
      expiresAt: '2026-12-01T14:30:00.000Z',
    });
    const again = await as(t, x.leaderA1).get(`/sites/${x.siteA1.id}/daily-code`).expect(200);
    expect(again.body.code).toBe(r.body.code);
  });

  it('la duración va de 20 a 30 minutos', async () => {
    const r = await as(t, x.leaderA1)
      .post(`/sites/${x.siteA1.id}/daily-code`, { ttlMinutes: 20 })
      .expect(201);
    expect(r.body.expiresAt).toBe('2026-12-01T14:20:00.000Z');
    await as(t, x.leaderA1).post(`/sites/${x.siteA1.id}/daily-code`, { ttlMinutes: 60 }).expect(400);
  });

  it('sin código vigente, 404', async () => {
    setNow('2026-12-01T16:00:00Z');
    await as(t, x.leaderA1).get(`/sites/${x.siteA1.id}/daily-code`).expect(404);
  });

  it('una sede sin ubicación configurada no genera códigos', async () => {
    const r = await as(t, x.adminA).post(`/sites/${x.siteA2.id}/daily-code`).expect(409);
    expect(r.body.code).toBe('TEMPORA_SITE_NOT_CONFIGURED');
  });

  it('solo quien tiene el permiso, en su sede y su compañía', async () => {
    await as(t, x.workerA1).post(`/sites/${x.siteA1.id}/daily-code`).expect(403);
    await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/daily-code`).expect(403);
    await as(t, x.leaderA1).post(`/sites/${x.siteA2.id}/daily-code`).expect(403);
    await as(t, x.adminB).post(`/sites/${x.siteA1.id}/daily-code`).expect(403);
    await as(t, x.adminA).get(`/sites/${x.siteB1.id}/daily-code`).expect(403);
    // El dueño de la plataforma no ve datos de los clientes.
    await as(t, x.owner).get(`/sites/${x.siteA1.id}/daily-code`).expect(403);
    await request(t.server).post(`/sites/${x.siteA1.id}/daily-code`).expect(401);
  });
});

describe('Entrada', () => {
  it('con el código vigente y dentro del radio: jornada abierta, sin revisión', async () => {
    setNow('2026-12-02T14:02:00Z');
    const code = await newCode();
    const r = await checkIn(x.workerA1, { code, location: NEAR }).expect(201);
    expect(r.body).toMatchObject({
      userId: x.workerA1.userId,
      siteId: x.siteA1.id,
      workDate: '2026-12-02',
      status: 'open',
      checkInAt: '2026-12-02T14:02:00.000Z',
      needsReview: false,
      reviewReasons: [],
    });
    expect(r.body.checkInDistanceM).toBeLessThan(50);

    const again = await checkIn(x.workerA1, { code, location: NEAR }).expect(409);
    expect(again.body.code).toBe('TEMPORA_ALREADY_CHECKED_IN');
  });

  it('la hora la pone el servidor: un campo de hora en el cuerpo se ignora', async () => {
    setNow('2026-12-03T14:00:00Z');
    const code = await newCode();
    const r = await checkIn(x.workerA1, { code, location: NEAR, checkInAt: '2026-12-03T13:00:00Z' }).expect(
      201,
    );
    expect(r.body.checkInAt).toBe('2026-12-03T14:00:00.000Z');
  });

  it('fuera del radio: se registra "por revisar" con la distancia real, no se rechaza', async () => {
    setNow('2026-12-04T14:00:00Z');
    const r = await checkIn(x.workerA1, { code: await newCode(), location: FAR }).expect(201);
    expect(r.body).toMatchObject({ needsReview: true, reviewReasons: ['entry:outside-radius'] });
    expect(r.body.checkInDistanceM).toBeGreaterThan(400);
  });

  it('sin ubicación: se registra "por revisar"', async () => {
    setNow('2026-12-05T14:00:00Z');
    const r = await checkIn(x.workerA1, { code: await newCode() }).expect(201);
    expect(r.body).toMatchObject({
      needsReview: true,
      reviewReasons: ['entry:no-location'],
      checkInDistanceM: null,
    });
  });

  it('código incorrecto o vencido: 422 con el motivo', async () => {
    setNow('2026-12-06T14:00:00Z');
    const code = await newCode();
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await checkIn(x.workerA1, { code: wrong, location: NEAR }).expect(422)).body.code).toBe(
      'TEMPORA_CODE_INVALID',
    );
    setNow('2026-12-06T14:30:00Z');
    expect((await checkIn(x.workerA1, { code, location: NEAR }).expect(422)).body.code).toBe(
      'TEMPORA_CODE_EXPIRED',
    );
    await checkIn(x.workerA1, { code: '12ab', location: NEAR }).expect(400);
  });

  it('generar un código nuevo vence el anterior', async () => {
    setNow('2026-12-07T14:00:00Z');
    const first = await newCode();
    setNow('2026-12-07T14:05:00Z');
    let second = await newCode();
    while (second === first) second = await newCode(); // uno en un millón
    expect((await checkIn(x.workerA1, { code: first, location: NEAR }).expect(422)).body.code).toBe(
      'TEMPORA_CODE_EXPIRED',
    );
    await checkIn(x.workerA1, { code: second, location: NEAR }).expect(201);
  });

  it('el código de una sede no sirve en otra, y nadie marca fuera de su sede', async () => {
    setNow('2026-12-08T14:00:00Z');
    const codeB = await newCode(x.siteB1.id, x.adminB);
    const r = await checkIn(x.workerA1, { code: codeB, location: NEAR });
    // Si por azar coincide con un código de A1, igual no hay uno vigente de A1 hoy.
    expect(r.status).toBe(422);
    await checkIn(x.workerA1, { code: codeB, location: NEAR }, x.siteB1.id).expect(403);
    await checkIn(x.workerA1, { code: codeB, location: NEAR }, x.siteA2.id).expect(403);
    await request(t.server)
      .post(`/sites/${x.siteA1.id}/attendance/check-in`)
      .send({ code: codeB })
      .expect(401);
  });
});

describe('Salida', () => {
  it('a la hora del cierre: salida normal, sin revisión', async () => {
    setNow('2026-12-09T14:00:00Z');
    await checkIn(x.workerA1, { code: await newCode(), location: NEAR }).expect(201);
    setNow('2026-12-09T23:05:00Z'); // 17:05
    const r = await checkOut(x.workerA1, { location: NEAR }).expect(200);
    expect(r.body).toMatchObject({
      status: 'closed',
      checkOutAt: '2026-12-09T23:05:00.000Z',
      checkOutKind: 'regular',
      needsReview: false,
    });
    const twice = await checkOut(x.workerA1, { location: NEAR }).expect(409);
    expect(twice.body.code).toBe('TEMPORA_ALREADY_CHECKED_OUT');
  });

  it('antes de la ventana de salida: pide motivo; con motivo, queda anticipada y por revisar', async () => {
    setNow('2026-12-10T14:00:00Z');
    await checkIn(x.workerA1, { code: await newCode(), location: NEAR }).expect(201);
    setNow('2026-12-10T21:00:00Z'); // 15:00, dos horas antes del cierre
    const noReason = await checkOut(x.workerA1, { location: NEAR }).expect(422);
    expect(noReason.body.code).toBe('TEMPORA_EARLY_EXIT_REASON_REQUIRED');
    const r = await checkOut(x.workerA1, { location: NEAR, reason: 'Cita en el IMSS' }).expect(200);
    expect(r.body).toMatchObject({
      checkOutKind: 'early',
      checkOutReason: 'Cita en el IMSS',
      needsReview: true,
      reviewReasons: ['exit:off-schedule'],
    });
  });

  it('más de 30 minutos después del cierre y fuera del radio: por revisar, con los dos motivos', async () => {
    setNow('2026-12-11T14:00:00Z');
    await checkIn(x.workerA1, { code: await newCode() }).expect(201);
    setNow('2026-12-12T00:00:00Z'); // 18:00 del 11 en CDMX
    const r = await checkOut(x.workerA1, { location: FAR }).expect(200);
    expect(r.body).toMatchObject({ checkOutKind: 'regular', workDate: '2026-12-11' });
    expect(r.body.reviewReasons).toEqual(['entry:no-location', 'exit:outside-radius', 'exit:off-schedule']);
  });

  it('sin entrada no hay salida', async () => {
    setNow('2026-12-13T23:00:00Z');
    // El administrador de la compañía también puede marcar, y nunca ha entrado en A1.
    expect((await checkOut(x.adminA).expect(409)).body.code).toBe('TEMPORA_NOT_CHECKED_IN');
  });

  it('si olvida la salida, al día siguiente queda "salida pendiente" y no la puede cerrar él', async () => {
    setNow('2026-12-14T14:00:00Z');
    const entry = await checkIn(x.workerA1, { code: await newCode(), location: NEAR }).expect(201);
    setNow('2026-12-15T14:00:00Z');
    const r = await checkOut(x.workerA1, { location: NEAR }).expect(409);
    expect(r.body.code).toBe('TEMPORA_EXIT_PENDING');

    const me = await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/attendance/me`).expect(200);
    expect(me.body).toMatchObject({ today: '2026-12-15', record: null });
    // Incluye las jornadas sin salida de pruebas anteriores de este mismo trabajador.
    expect(me.body.pendingExits).toContainEqual(
      expect.objectContaining({ id: entry.body.id, status: 'pending-exit', workDate: '2026-12-14' }),
    );
    // Y puede entrar hoy normalmente.
    await checkIn(x.workerA1, { code: await newCode(), location: NEAR }).expect(201);
    const after = await as(t, x.workerA1).get(`/sites/${x.siteA1.id}/attendance/me`).expect(200);
    expect(after.body.record).toMatchObject({ workDate: '2026-12-15', status: 'open' });
  });
});

describe('Auditoría y aislamiento', () => {
  it('cada código, entrada y salida queda en la auditoría de su compañía, con autor y sin coordenadas', async () => {
    setNow('2026-12-16T14:00:00Z');
    await newCode();
    const entry = await checkIn(x.leaderA1, { code: await newCode(), location: NEAR }).expect(201);
    setNow('2026-12-16T23:00:00Z');
    await checkOut(x.leaderA1, { location: NEAR }).expect(200);

    const a = await as(t, x.adminA).get(`/companies/${x.companyA.id}/audit?limit=200`).expect(200);
    const mine = a.body.filter((e: { targetId: string }) => e.targetId === entry.body.id);
    expect(mine.map((e: { action: string }) => e.action).toSorted()).toEqual([
      'attendance.check-in',
      'attendance.check-out',
    ]);
    for (const e of mine) {
      expect(e.actorUserId).toBe(x.leaderA1.userId);
      expect(JSON.stringify(e)).not.toMatch(/latitude|longitude/);
    }
    expect(a.body.some((e: { action: string }) => e.action === 'daily-code.create')).toBe(true);

    const b = await as(t, x.adminB).get(`/companies/${x.companyB.id}/audit?limit=200`).expect(200);
    expect(b.body.some((e: { action: string }) => e.action.startsWith('attendance.'))).toBe(false);
  });

  it('el trabajador no ve la jornada de la compañía B ni de otra sede', async () => {
    await as(t, x.workerA1).get(`/sites/${x.siteB1.id}/attendance/me`).expect(403);
    await as(t, x.workerA1).get(`/sites/${x.siteA2.id}/attendance/me`).expect(403);
    await as(t, x.adminB).get(`/sites/${x.siteA1.id}/attendance/me`).expect(403);
  });

  it('OpenAPI documenta las rutas de jornada', () => {
    const doc = t.openapi as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths['/sites/{siteId}/attendance/check-in']?.['post']).toBeDefined();
    expect(doc.paths['/sites/{siteId}/daily-code']?.['post']).toBeDefined();
  });
});

describe('Fuerza bruta del código', () => {
  it('después de 10 intentos por minuto, 429', async () => {
    setNow('2026-12-20T14:00:00Z');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await checkIn(x.workerA1, { code: String(100000 + i) })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 422 || s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
