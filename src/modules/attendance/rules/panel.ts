import type { RecordStatus } from './marking.js';
import { addDays, type Shift, zonedTime } from './workday.js';

/**
 * Panel del líder y calendario del trabajador: cómo se ve un día. Solo describe lo que pasó; no
 * decide retardos (la tolerancia de cada sede es la pregunta abierta 4 del PRD) ni calcula dinero.
 */

const MIN = 60_000;

/** Estado de una persona en un día del panel: aún no entra ("missing") o el de su jornada. */
export type DayStatus = 'missing' | RecordStatus;

/** Minutos trabajados entre entrada y salida, o null si no hay salida. */
export function workedMinutes(checkInAt: Date, checkOutAt: Date | null): number | null {
  if (!checkOutAt) return null;
  return Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / MIN));
}

/**
 * Minutos después de la entrada oficial, o 0 si llegó antes. Null si la sede no tiene horario. No
 * es un "retardo": eso depende de una tolerancia que aún no está definida.
 */
export function minutesAfterStart(
  checkInAt: Date,
  workDate: string,
  shift: Shift | null,
  timeZone: string,
): number | null {
  if (!shift) return null;
  const start = zonedTime(workDate, shift.start, timeZone);
  return Math.max(0, Math.floor((checkInAt.getTime() - start.getTime()) / MIN));
}

export interface PanelRow {
  status: DayStatus;
  needsReview: boolean;
  manual: boolean;
  onRoster: boolean;
}

export interface PanelSummary {
  /** Personas asignadas a la sede que marcan asistencia. */
  expected: number;
  /** Entraron (con o sin salida). */
  arrived: number;
  /** Asignadas que no han entrado. */
  missing: number;
  /** Siguen dentro. */
  open: number;
  closed: number;
  pendingExit: number;
  needsReview: number;
  /** Jornadas con entrada o salida registrada por el líder. */
  manual: number;
}

export function summarize(rows: readonly PanelRow[]): PanelSummary {
  const s: PanelSummary = {
    expected: 0,
    arrived: 0,
    missing: 0,
    open: 0,
    closed: 0,
    pendingExit: 0,
    needsReview: 0,
    manual: 0,
  };
  for (const r of rows) {
    if (r.onRoster) s.expected++;
    if (r.status === 'missing') {
      s.missing++;
      continue;
    }
    s.arrived++;
    if (r.status === 'open') s.open++;
    else if (r.status === 'closed') s.closed++;
    else s.pendingExit++;
    if (r.needsReview) s.needsReview++;
    if (r.manual) s.manual++;
  }
  return s;
}

/** Mes "YYYY-MM". */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Los días "YYYY-MM-DD" de un mes "YYYY-MM". */
export function monthDays(month: string): string[] {
  if (!MONTH.test(month)) throw new RangeError(`Mes inválido: ${month}`);
  const days: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) days.push(d);
  return days;
}

/** Estado de un día en el calendario del trabajador. */
export type CalendarStatus = RecordStatus | 'no-record' | 'future';

/**
 * Un día sin jornada es "no-record", no "falta": la sede aún no tiene días de descanso ni
 * calendario laboral, así que no se puede saber si debía trabajar.
 */
export function calendarStatus(date: string, today: string, record: RecordStatus | null): CalendarStatus {
  if (record) return record;
  return date > today ? 'future' : 'no-record';
}

/** Días máximos de un rango de exportación (dos quincenas y algo, o un mes completo). */
export const EXPORT_MAX_DAYS = 62;

/** Número de días de `from` a `to`, ambos incluidos ("YYYY-MM-DD"). */
export function daysInRange(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
