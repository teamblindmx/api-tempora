import { describe, expect, it } from 'vitest';
import { CORRECTION_MAX_DAYS_BACK, planCorrection } from './correction.js';

const now = new Date('2026-12-10T20:00:00Z');
const record = {
  workDate: '2026-12-09',
  checkInAt: new Date('2026-12-09T14:05:00Z'),
  checkOutAt: new Date('2026-12-09T23:00:00Z'),
};
const base = { record, checkInAt: null, checkOutAt: null, checkInDate: null, now, today: '2026-12-10' };

describe('planCorrection', () => {
  it('corrige la entrada, la salida o las dos, y dice qué cambió', () => {
    const inOnly = planCorrection({
      ...base,
      checkInAt: new Date('2026-12-09T14:00:00Z'),
      checkInDate: '2026-12-09',
    });
    expect(inOnly).toMatchObject({ ok: true, checkInChanged: true, checkOutChanged: false });
    const outOnly = planCorrection({ ...base, checkOutAt: new Date('2026-12-09T23:30:00Z') });
    expect(outOnly).toMatchObject({
      ok: true,
      checkInAt: record.checkInAt,
      checkInChanged: false,
      checkOutChanged: true,
    });
  });

  it('rechaza una corrección que no cambia nada', () => {
    expect(planCorrection({ ...base, checkInAt: record.checkInAt, checkInDate: '2026-12-09' })).toEqual({
      ok: false,
      problem: 'nothing-to-change',
    });
  });

  it('no agrega una salida que no existe (eso es marcado manual)', () => {
    expect(
      planCorrection({
        ...base,
        record: { ...record, checkOutAt: null },
        checkOutAt: new Date('2026-12-09T23:00:00Z'),
      }),
    ).toEqual({ ok: false, problem: 'no-exit' });
  });

  it(`solo corrige los últimos ${CORRECTION_MAX_DAYS_BACK} días`, () => {
    expect(
      planCorrection({ ...base, today: '2027-01-09', checkOutAt: new Date('2026-12-09T23:30:00Z') }),
    ).toMatchObject({ ok: true });
    expect(
      planCorrection({ ...base, today: '2027-01-10', checkOutAt: new Date('2026-12-09T23:30:00Z') }),
    ).toEqual({ ok: false, problem: 'too-old' });
  });

  it('rechaza el futuro, cambiar de día, salir antes de entrar y jornadas de más de 24 h', () => {
    expect(planCorrection({ ...base, checkOutAt: new Date('2026-12-10T20:01:00Z') })).toEqual({
      ok: false,
      problem: 'future',
    });
    expect(
      planCorrection({ ...base, checkInAt: new Date('2026-12-08T14:00:00Z'), checkInDate: '2026-12-08' }),
    ).toEqual({ ok: false, problem: 'other-day' });
    expect(
      planCorrection({ ...base, checkInAt: new Date('2026-12-09T23:30:00Z'), checkInDate: '2026-12-09' }),
    ).toEqual({ ok: false, problem: 'before-check-in' });
    expect(
      planCorrection({
        ...base,
        today: '2026-12-11',
        now: new Date('2026-12-11T20:00:00Z'),
        checkOutAt: new Date('2026-12-10T14:06:00Z'),
      }),
    ).toEqual({ ok: false, problem: 'too-long' });
  });
});
