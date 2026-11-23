import { describe, expect, it } from 'vitest';
import { authorizedEnd, overtimeMinutes, splitWeeklyOvertime } from './overtime.js';

describe('splitWeeklyOvertime', () => {
  it('hasta 3 al día son dobles', () => {
    expect(splitWeeklyOvertime([2, 3])).toEqual([
      { double: 2, triple: 0 },
      { double: 3, triple: 0 },
    ]);
  });
  it('más de 3 en un día pasan a triples', () => {
    expect(splitWeeklyOvertime([4.5])).toEqual([{ double: 3, triple: 1.5 }]);
  });
  it('después de 9 dobles en la semana, todo es triple', () => {
    expect(splitWeeklyOvertime([3, 3, 3, 2])).toEqual([
      { double: 3, triple: 0 },
      { double: 3, triple: 0 },
      { double: 3, triple: 0 },
      { double: 0, triple: 2 },
    ]);
    expect(splitWeeklyOvertime([3, 3, 2, 3])[3]).toEqual({ double: 1, triple: 2 });
  });
  it('rechaza horas negativas', () => {
    expect(() => splitWeeklyOvertime([-1])).toThrow(RangeError);
  });
});

const at = (iso: string) => new Date(iso);

describe('overtimeMinutes (regla 9)', () => {
  const end = new Date('2026-12-01T23:00:00Z');

  it('sin autorización, todo lo posterior al cierre es tiempo no autorizado', () => {
    expect(overtimeMinutes(end, at('2026-12-02T00:30:00Z'), null)).toEqual({
      extraMinutes: 90,
      authorizedMinutes: 0,
      unauthorizedMinutes: 90,
    });
    expect(overtimeMinutes(end, at('2026-12-01T22:00:00Z'), null).extraMinutes).toBe(0);
  });

  it('autorizada hasta una hora: lo que pasa de esa hora no está autorizado', () => {
    const auth = { until: at('2026-12-02T01:00:00Z'), closedAt: null };
    expect(overtimeMinutes(end, at('2026-12-02T00:30:00Z'), auth)).toMatchObject({
      authorizedMinutes: 90,
      unauthorizedMinutes: 0,
    });
    expect(overtimeMinutes(end, at('2026-12-02T02:00:00Z'), auth)).toMatchObject({
      authorizedMinutes: 120,
      unauthorizedMinutes: 60,
    });
  });

  it('jornada abierta: todo autorizado hasta que el líder la cierra', () => {
    expect(overtimeMinutes(end, at('2026-12-02T03:00:00Z'), { until: null, closedAt: null })).toMatchObject({
      authorizedMinutes: 240,
      unauthorizedMinutes: 0,
    });
    const closed = { until: null, closedAt: at('2026-12-02T01:00:00Z') };
    expect(overtimeMinutes(end, at('2026-12-02T03:00:00Z'), closed)).toMatchObject({
      authorizedMinutes: 120,
      unauthorizedMinutes: 120,
    });
  });

  it('cerrar antes de `until` corta la autorización', () => {
    const auth = { until: at('2026-12-02T03:00:00Z'), closedAt: at('2026-12-01T23:30:00Z') };
    expect(authorizedEnd(auth)).toEqual(at('2026-12-01T23:30:00Z'));
    expect(overtimeMinutes(end, at('2026-12-02T01:00:00Z'), auth)).toMatchObject({
      authorizedMinutes: 30,
      unauthorizedMinutes: 90,
    });
  });
});
