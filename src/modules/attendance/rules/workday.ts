/**
 * Fechas y horas en la zona horaria de la sede. La hora la pone el servidor (regla 1); aquí solo se
 * traduce un instante a "qué día es en la sede" y un horario local ("17:00") a un instante.
 */

/** Hora local en formato 24 h, "HH:MM". */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface Shift {
  /** Entrada oficial, "HH:MM" en la zona de la sede. */
  start: string;
  /** Cierre oficial, "HH:MM". Si es igual o anterior a la entrada, el turno termina al día siguiente. */
  end: string;
}

/** ¿Es una zona horaria IANA que reconoce el motor (p. ej. "America/Mexico_City")? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function parts(instant: Date, timeZone: string) {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

/** Día de jornada ("YYYY-MM-DD") del instante en la zona de la sede. */
export function localDate(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Suma días a una fecha "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Diferencia en ms entre la hora local de la zona y UTC en ese instante. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instante de una fecha y hora locales de la sede ("2026-11-18", "17:00"). */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  if (!HHMM.test(time)) throw new RangeError(`Hora inválida: ${time}`);
  const [y = NaN, m = NaN, d = NaN] = date.split('-').map(Number);
  const [h = NaN, min = NaN] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  if (Number.isNaN(guess)) throw new RangeError(`Fecha inválida: ${date}`);
  // Dos pasadas para cubrir un cambio de horario entre la suposición y el resultado.
  let t = guess - offsetMs(new Date(guess), timeZone);
  t = guess - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** ¿El turno cruza la medianoche? */
export function crossesMidnight(shift: Shift): boolean {
  return shift.end <= shift.start;
}

/** Cierre oficial del turno que empieza el día `workDate`. */
export function scheduledEnd(workDate: string, shift: Shift, timeZone: string): Date {
  return zonedTime(crossesMidnight(shift) ? addDays(workDate, 1) : workDate, shift.end, timeZone);
}
