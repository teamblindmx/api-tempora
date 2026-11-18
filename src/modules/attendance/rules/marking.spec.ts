import { describe, expect, it } from 'vitest';
import { canSelfCheckOut, evaluateCheckOut, locationReview, recordStatus } from './marking.js';

const end = new Date('2026-11-18T23:00:00Z'); // 17:00 en CDMX
const at = (iso: string) => new Date(iso);
const ok = { status: 'ok', distanceM: 40 } as const;
const base = { scheduledEnd: end, overtimeAuthorized: false, location: ok, reason: null };

describe('locationReview', () => {
  it('dentro del radio no se revisa; fuera o sin ubicación, sí', () => {
    expect(locationReview('entry', ok)).toEqual([]);
    expect(locationReview('entry', { status: 'review', reason: 'no-location', distanceM: null })).toEqual([
      'entry:no-location',
    ]);
    expect(locationReview('exit', { status: 'review', reason: 'outside-radius', distanceM: 900 })).toEqual([
      'exit:outside-radius',
    ]);
  });
});

describe('evaluateCheckOut', () => {
  it('salida a tiempo: normal y sin revisión', () => {
    expect(evaluateCheckOut({ ...base, now: at('2026-11-18T23:05:00Z') })).toEqual({
      ok: true,
      kind: 'regular',
      reviewReasons: [],
    });
  });

  it('salida anticipada sin motivo: se pide el motivo', () => {
    expect(evaluateCheckOut({ ...base, now: at('2026-11-18T21:00:00Z') })).toEqual({
      ok: false,
      error: 'early-exit-reason-required',
    });
  });

  it('salida anticipada con motivo: se guarda, y por revisar si pasa de 30 minutos', () => {
    expect(evaluateCheckOut({ ...base, now: at('2026-11-18T21:00:00Z'), reason: 'Cita médica' })).toEqual({
      ok: true,
      kind: 'early',
      reviewReasons: ['exit:off-schedule'],
    });
  });

  it('salida más de 30 minutos tarde sin autorización: por revisar', () => {
    const r = evaluateCheckOut({ ...base, now: at('2026-11-19T00:00:00Z') });
    expect(r).toMatchObject({ ok: true, kind: 'regular', reviewReasons: ['exit:off-schedule'] });
    expect(
      evaluateCheckOut({ ...base, now: at('2026-11-19T00:00:00Z'), overtimeAuthorized: true }),
    ).toMatchObject({ reviewReasons: [] });
  });

  it('sin horario configurado: salida normal; solo cuenta la ubicación', () => {
    expect(
      evaluateCheckOut({
        ...base,
        scheduledEnd: null,
        now: at('2026-11-18T15:00:00Z'),
        location: { status: 'review', reason: 'no-location', distanceM: null },
      }),
    ).toEqual({ ok: true, kind: 'regular', reviewReasons: ['exit:no-location'] });
  });
});

describe('canSelfCheckOut y recordStatus', () => {
  const day = { start: '08:00', end: '17:00' };
  const night = { start: '22:00', end: '06:00' };

  it('la jornada de hoy se cierra; la de ayer queda como salida pendiente', () => {
    expect(canSelfCheckOut('2026-11-18', '2026-11-18', day)).toBe(true);
    expect(canSelfCheckOut('2026-11-17', '2026-11-18', day)).toBe(false);
    expect(canSelfCheckOut('2026-11-17', '2026-11-18', null)).toBe(false);
  });

  it('un turno de noche se cierra al día siguiente', () => {
    expect(canSelfCheckOut('2026-11-17', '2026-11-18', night)).toBe(true);
    expect(canSelfCheckOut('2026-11-16', '2026-11-18', night)).toBe(false);
  });

  it('estado para mostrar', () => {
    const today = '2026-11-18';
    expect(recordStatus({ workDate: today, checkOutAt: null }, today, day)).toBe('open');
    expect(recordStatus({ workDate: '2026-11-17', checkOutAt: null }, today, day)).toBe('pending-exit');
    expect(recordStatus({ workDate: '2026-11-17', checkOutAt: new Date() }, today, day)).toBe('closed');
  });
});
