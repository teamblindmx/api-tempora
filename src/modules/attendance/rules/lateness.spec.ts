import { describe, expect, it } from 'vitest';
import { evaluateLateness } from './lateness.js';

const TZ = 'America/Mexico_City';
const shift = { start: '08:00', end: '17:00' };
const base = {
  workDate: '2026-12-01',
  shift,
  timeZone: TZ,
  toleranceMin: 10,
  workday: true,
  codeExpired: false,
};
// 08:00 en CDMX es 14:00 UTC.
const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00Z`);

describe('evaluateLateness (regla 10)', () => {
  it('antes o dentro de la tolerancia no es retardo; pasarla sí', () => {
    expect(evaluateLateness({ ...base, checkInAt: at('13:50') })).toEqual({
      late: false,
      minutesAfterStart: 0,
    });
    expect(evaluateLateness({ ...base, checkInAt: at('14:10') })).toEqual({
      late: false,
      minutesAfterStart: 10,
    });
    expect(evaluateLateness({ ...base, checkInAt: at('14:11') })).toEqual({
      late: true,
      minutesAfterStart: 11,
    });
  });

  it('la tolerancia es de la sede', () => {
    expect(evaluateLateness({ ...base, toleranceMin: 15, checkInAt: at('14:12') }).late).toBe(false);
    expect(evaluateLateness({ ...base, toleranceMin: 0, checkInAt: at('14:01') }).late).toBe(true);
  });

  it('en un descanso o festivo no hay retardo, aunque se muestran los minutos', () => {
    expect(evaluateLateness({ ...base, workday: false, checkInAt: at('15:00') })).toEqual({
      late: false,
      minutesAfterStart: 60,
    });
  });

  it('sin horario, solo la entrada con código vencido cuenta como retardo', () => {
    expect(evaluateLateness({ ...base, shift: null, checkInAt: at('15:00') })).toEqual({
      late: false,
      minutesAfterStart: null,
    });
    expect(evaluateLateness({ ...base, shift: null, codeExpired: true, checkInAt: at('15:00') }).late).toBe(
      true,
    );
  });

  it('con horario manda la hora: un código vencido no es retardo si llegó a tiempo', () => {
    expect(evaluateLateness({ ...base, codeExpired: true, checkInAt: at('14:05') }).late).toBe(false);
  });
});
