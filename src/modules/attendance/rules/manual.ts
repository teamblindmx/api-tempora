import { addDays } from './workday.js';

/**
 * Marcado manual del líder (regla 13: todo ajuste manual lleva comentario y queda auditado). El líder
 * marca por un trabajador que no pudo hacerlo (sin teléfono, sin señal) o cierra una salida pendiente.
 * Nunca por sí mismo: eso saltaría el código y la ubicación.
 */

/** Días hacia atrás (en la zona de la sede) que el líder puede registrar a mano. */
export const MANUAL_MAX_DAYS_BACK = 7;
/** Una jornada no puede durar más que esto: una salida más tarde es un error de captura. */
export const MAX_WORKDAY_HOURS = 24;

const HOUR = 3_600_000;

export type ManualCheckInProblem = 'future' | 'too-old';
export type ManualCheckOutProblem = 'future' | 'before-check-in' | 'too-long';

/** ¿Puede el líder registrar una entrada a la hora `at`? `workDate` es el día local de `at`. */
export function manualCheckInProblem(input: {
  at: Date;
  now: Date;
  workDate: string;
  today: string;
}): ManualCheckInProblem | null {
  if (input.at.getTime() > input.now.getTime()) return 'future';
  if (input.workDate < addDays(input.today, -MANUAL_MAX_DAYS_BACK)) return 'too-old';
  return null;
}

/** ¿Puede el líder registrar la salida a la hora `at` de una jornada que entró en `checkInAt`? */
export function manualCheckOutProblem(input: {
  at: Date;
  now: Date;
  checkInAt: Date;
}): ManualCheckOutProblem | null {
  if (input.at.getTime() > input.now.getTime()) return 'future';
  if (input.at.getTime() < input.checkInAt.getTime()) return 'before-check-in';
  if (input.at.getTime() - input.checkInAt.getTime() > MAX_WORKDAY_HOURS * HOUR) return 'too-long';
  return null;
}
