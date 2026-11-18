import { describe, expect, it } from 'vitest';
import { manualCheckInProblem, manualCheckOutProblem } from './manual.js';

const now = new Date('2026-12-10T20:00:00Z');

describe('manualCheckInProblem', () => {
  it('acepta una hora de hoy o de hasta 7 días antes', () => {
    expect(manualCheckInProblem({ at: now, now, workDate: '2026-12-10', today: '2026-12-10' })).toBeNull();
    expect(
      manualCheckInProblem({
        at: new Date('2026-12-03T14:00:00Z'),
        now,
        workDate: '2026-12-03',
        today: '2026-12-10',
      }),
    ).toBeNull();
  });
  it('rechaza el futuro y lo que tiene más de 7 días', () => {
    expect(
      manualCheckInProblem({
        at: new Date('2026-12-10T20:01:00Z'),
        now,
        workDate: '2026-12-10',
        today: '2026-12-10',
      }),
    ).toBe('future');
    expect(
      manualCheckInProblem({
        at: new Date('2026-12-02T14:00:00Z'),
        now,
        workDate: '2026-12-02',
        today: '2026-12-10',
      }),
    ).toBe('too-old');
  });
});

describe('manualCheckOutProblem', () => {
  const checkInAt = new Date('2026-12-09T14:00:00Z');
  it('acepta una salida entre la entrada y ahora', () => {
    expect(manualCheckOutProblem({ at: new Date('2026-12-09T23:00:00Z'), now, checkInAt })).toBeNull();
    expect(manualCheckOutProblem({ at: checkInAt, now, checkInAt })).toBeNull();
  });
  it('rechaza el futuro, antes de la entrada y jornadas de más de 24 horas', () => {
    expect(manualCheckOutProblem({ at: new Date('2026-12-10T21:00:00Z'), now, checkInAt })).toBe('future');
    expect(manualCheckOutProblem({ at: new Date('2026-12-09T13:59:00Z'), now, checkInAt })).toBe(
      'before-check-in',
    );
    expect(manualCheckOutProblem({ at: new Date('2026-12-10T14:01:00Z'), now, checkInAt })).toBe('too-long');
  });
});
