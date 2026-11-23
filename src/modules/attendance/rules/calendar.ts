import { addDays } from './workday.js';

/**
 * Etiquetado de días (reglas 15 y 16): cada día es ordinario, domingo, descanso o festivo. Los días
 * de descanso son de la sede (la "cuadrilla" aún no existe en el modelo: pregunta abierta 3); no se
 * asume sábado y domingo. Solo se etiqueta: lo que se paga lo decide nómina (regla 17).
 */

export type DayType = 'ordinary' | 'sunday' | 'rest' | 'holiday';

/** Descanso por omisión: el domingo (LFT art. 69 y 71: de preferencia en domingo). ADR 0014. */
export const DEFAULT_REST_DAYS: readonly number[] = [0];

/** Día de la semana de una fecha "YYYY-MM-DD": 0 = domingo ... 6 = sábado. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export interface DayInfo {
  dayType: DayType;
  /** También es domingo (para la prima dominical, aunque sea descanso o festivo). */
  sunday: boolean;
  /** Nombre del festivo, si lo es. */
  holidayName: string | null;
  /** ¿Se espera que trabaje? Solo los días ordinarios y los domingos que no son descanso. */
  workday: boolean;
}

/**
 * Un festivo pesa más que un descanso, y un descanso más que un domingo: un domingo de descanso es
 * "rest" con `sunday: true`. Nómina ve las dos cosas.
 */
export function dayInfo(date: string, restDays: readonly number[], holidayName: string | null): DayInfo {
  const wd = weekday(date);
  const sunday = wd === 0;
  const dayType: DayType = holidayName
    ? 'holiday'
    : restDays.includes(wd)
      ? 'rest'
      : sunday
        ? 'sunday'
        : 'ordinary';
  return { dayType, sunday, holidayName, workday: dayType === 'ordinary' || dayType === 'sunday' };
}

/** "YYYY-MM-DD" del n-ésimo `wd` (0 = domingo) de un mes (1 a 12). */
function nthWeekday(year: number, month: number, wd: number, n: number): string {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const offset = (wd - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

export interface StatutoryHoliday {
  date: string;
  name: string;
}

/**
 * Descanso obligatorio del artículo 74 de la LFT para un año. No incluye el día de elecciones
 * (fracción IX), que fijan las leyes electorales: se agrega a mano cuando toque.
 */
export function mexicanStatutoryHolidays(year: number): StatutoryHoliday[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new RangeError(`Año inválido: ${year}`);
  const list: StatutoryHoliday[] = [
    { date: `${year}-01-01`, name: 'Año Nuevo' },
    { date: nthWeekday(year, 2, 1, 1), name: 'Día de la Constitución' },
    { date: nthWeekday(year, 3, 1, 3), name: 'Natalicio de Benito Juárez' },
    { date: `${year}-05-01`, name: 'Día del Trabajo' },
    { date: `${year}-09-16`, name: 'Día de la Independencia' },
    { date: nthWeekday(year, 11, 1, 3), name: 'Día de la Revolución' },
    { date: `${year}-12-25`, name: 'Navidad' },
  ];
  // Fracción VII: 1 de octubre cada seis años, con la transmisión del Poder Ejecutivo (2024, 2030...).
  if ((year - 2024) % 6 === 0) {
    list.push({ date: `${year}-10-01`, name: 'Transmisión del Poder Ejecutivo Federal' });
  }
  return list.toSorted((a, b) => a.date.localeCompare(b.date));
}
