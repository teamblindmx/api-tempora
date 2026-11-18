import { describe, expect, it } from 'vitest';
import {
  calendarStatus,
  daysInRange,
  minutesAfterStart,
  monthDays,
  summarize,
  workedMinutes,
} from './panel.js';

const CDMX = 'America/Mexico_City';

describe('workedMinutes', () => {
  it('minutos entre entrada y salida; null sin salida', () => {
    expect(workedMinutes(new Date('2026-12-01T14:00:00Z'), new Date('2026-12-01T23:00:00Z'))).toBe(540);
    expect(workedMinutes(new Date('2026-12-01T14:00:00Z'), null)).toBeNull();
  });
});

describe('minutesAfterStart', () => {
  const shift = { start: '08:00', end: '17:00' };
  it('cuenta desde la entrada oficial en la zona de la sede; antes de la hora es 0', () => {
    expect(minutesAfterStart(new Date('2026-12-01T14:12:30Z'), '2026-12-01', shift, CDMX)).toBe(12);
    expect(minutesAfterStart(new Date('2026-12-01T13:50:00Z'), '2026-12-01', shift, CDMX)).toBe(0);
  });
  it('sin horario no hay referencia', () => {
    expect(minutesAfterStart(new Date('2026-12-01T14:12:00Z'), '2026-12-01', null, CDMX)).toBeNull();
  });
});

const row = (status: 'missing' | 'open' | 'closed' | 'pending-exit', extra = {}) => ({
  status,
  needsReview: false,
  manual: false,
  onRoster: true,
  ...extra,
});

describe('summarize', () => {
  it('cuenta esperados, llegadas, faltantes y estados', () => {
    expect(
      summarize([
        row('missing'),
        row('open', { needsReview: true }),
        row('closed', { manual: true }),
        // Marcó en la sede pero ya no está asignada: cuenta como llegada, no como esperada.
        row('closed', { onRoster: false }),
      ]),
    ).toEqual({
      expected: 3,
      arrived: 3,
      missing: 1,
      open: 1,
      closed: 2,
      pendingExit: 0,
      needsReview: 1,
      manual: 1,
    });
  });
});

describe('calendario', () => {
  it('monthDays da todos los días del mes, con febrero y años bisiestos', () => {
    expect(monthDays('2026-12')).toHaveLength(31);
    expect(monthDays('2027-02').at(-1)).toBe('2027-02-28');
    expect(monthDays('2028-02').at(-1)).toBe('2028-02-29');
    expect(() => monthDays('2026-13')).toThrow(RangeError);
  });
  it('un día sin jornada es "no-record" (no "falta"); después de hoy, "future"', () => {
    expect(calendarStatus('2026-12-01', '2026-12-10', null)).toBe('no-record');
    expect(calendarStatus('2026-12-11', '2026-12-10', null)).toBe('future');
    expect(calendarStatus('2026-12-01', '2026-12-10', 'closed')).toBe('closed');
  });
});

describe('daysInRange', () => {
  it('incluye los dos extremos', () => {
    expect(daysInRange('2026-12-01', '2026-12-01')).toBe(1);
    expect(daysInRange('2026-12-01', '2026-12-15')).toBe(15);
    expect(daysInRange('2026-12-16', '2027-01-15')).toBe(31);
  });
});
