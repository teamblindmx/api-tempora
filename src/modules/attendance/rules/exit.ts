/** Minutos antes del cierre en que se habilita la salida normal (regla 6). */
export const EXIT_WINDOW_MIN = 30;
/** Diferencia con el horario que manda la salida a revisión (regla 8). */
export const EXIT_REVIEW_THRESHOLD_MIN = 30;

const MIN = 60_000;

export type ExitKind = 'regular' | 'early';

/** Regla 6: salida normal desde 30 minutos antes del cierre; antes, "salida anticipada" con motivo. */
export function exitKind(now: Date, scheduledEnd: Date): ExitKind {
  return now.getTime() >= scheduledEnd.getTime() - EXIT_WINDOW_MIN * MIN ? 'regular' : 'early';
}

/** Regla 8: si la salida difiere más de 30 minutos del horario y no hay autorización, por revisar. */
export function exitNeedsReview(actualExit: Date, scheduledEnd: Date, authorized: boolean): boolean {
  if (authorized) return false;
  return Math.abs(actualExit.getTime() - scheduledEnd.getTime()) > EXIT_REVIEW_THRESHOLD_MIN * MIN;
}
