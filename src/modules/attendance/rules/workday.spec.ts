import { describe, expect, it } from 'vitest';
import { addDays, isValidTimeZone, localDate, scheduledEnd, zonedTime } from './workday.js';

const CDMX = 'America/Mexico_City'; // UTC-6, sin horario de verano desde 2022.
const TIJUANA = 'America/Tijuana'; // Sí cambia de horario (frontera).

describe('localDate', () => {
  it('usa el día de la sede, no el de UTC', () => {
    // 2026-11-19 03:00 UTC son las 21:00 del 18 en CDMX.
    expect(localDate(new Date('2026-11-19T03:00:00Z'), CDMX)).toBe('2026-11-18');
    expect(localDate(new Date('2026-11-19T06:00:00Z'), CDMX)).toBe('2026-11-19');
  });
});

describe('addDays', () => {
  it('cruza fin de mes y de año', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
});

describe('zonedTime', () => {
  it('convierte una hora local de la sede a un instante', () => {
    expect(zonedTime('2026-11-18', '17:00', CDMX).toISOString()).toBe('2026-11-18T23:00:00.000Z');
  });
  it('respeta el horario de verano donde aplica', () => {
    expect(zonedTime('2026-07-01', '08:00', TIJUANA).toISOString()).toBe('2026-07-01T15:00:00.000Z');
    expect(zonedTime('2026-12-01', '08:00', TIJUANA).toISOString()).toBe('2026-12-01T16:00:00.000Z');
  });
  it('rechaza horas mal escritas', () => {
    expect(() => zonedTime('2026-11-18', '25:00', CDMX)).toThrow(RangeError);
  });
});

describe('scheduledEnd', () => {
  it('turno de día: cierra el mismo día', () => {
    expect(scheduledEnd('2026-11-18', { start: '08:00', end: '17:00' }, CDMX).toISOString()).toBe(
      '2026-11-18T23:00:00.000Z',
    );
  });
  it('turno de noche: cierra al día siguiente', () => {
    expect(scheduledEnd('2026-11-18', { start: '22:00', end: '06:00' }, CDMX).toISOString()).toBe(
      '2026-11-19T12:00:00.000Z',
    );
  });
});

describe('isValidTimeZone', () => {
  it('acepta zonas IANA y rechaza lo demás', () => {
    expect(isValidTimeZone(CDMX)).toBe(true);
    expect(isValidTimeZone('Mexico/Guadalajara')).toBe(false);
  });
});
