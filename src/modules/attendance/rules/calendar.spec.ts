import { describe, expect, it } from 'vitest';
import { dayInfo, mexicanStatutoryHolidays, weekday } from './calendar.js';

describe('dayInfo (reglas 15 y 16)', () => {
  it('etiqueta ordinario, domingo, descanso y festivo', () => {
    expect(weekday('2026-12-06')).toBe(0);
    expect(dayInfo('2026-12-01', [0], null)).toMatchObject({ dayType: 'ordinary', workday: true });
    expect(dayInfo('2026-12-06', [6], null)).toMatchObject({
      dayType: 'sunday',
      sunday: true,
      workday: true,
    });
    expect(dayInfo('2026-12-05', [6], null)).toMatchObject({
      dayType: 'rest',
      sunday: false,
      workday: false,
    });
    expect(dayInfo('2026-12-25', [0], 'Navidad')).toMatchObject({
      dayType: 'holiday',
      holidayName: 'Navidad',
      workday: false,
    });
  });

  it('un domingo de descanso es descanso, pero sigue diciendo que es domingo', () => {
    expect(dayInfo('2026-12-06', [0], null)).toMatchObject({ dayType: 'rest', sunday: true, workday: false });
  });

  it('no asume sábado y domingo: sin días de descanso, todos son laborables', () => {
    expect(dayInfo('2026-12-05', [], null).workday).toBe(true);
  });
});

describe('mexicanStatutoryHolidays (LFT art. 74)', () => {
  it('2027: fechas fijas y lunes que se mueven', () => {
    expect(mexicanStatutoryHolidays(2027)).toEqual([
      { date: '2027-01-01', name: 'Año Nuevo' },
      { date: '2027-02-01', name: 'Día de la Constitución' },
      { date: '2027-03-15', name: 'Natalicio de Benito Juárez' },
      { date: '2027-05-01', name: 'Día del Trabajo' },
      { date: '2027-09-16', name: 'Día de la Independencia' },
      { date: '2027-11-15', name: 'Día de la Revolución' },
      { date: '2027-12-25', name: 'Navidad' },
    ]);
  });

  it('el 1 de octubre solo cada seis años', () => {
    expect(mexicanStatutoryHolidays(2030).map((h) => h.date)).toContain('2030-10-01');
    expect(mexicanStatutoryHolidays(2029).map((h) => h.date)).not.toContain('2029-10-01');
  });
});
