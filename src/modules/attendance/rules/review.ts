import type { ReviewReason } from './marking.js';

/**
 * Revisión de jornadas "por revisar" (reglas 3 y 8, ADR 0015). Un marcado fuera del radio, sin
 * ubicación o con una salida lejos del horario nunca se rechaza: queda con su motivo y el líder lo
 * revisa. Los motivos se guardan siempre (son evidencia); revisar solo anota cuáles ya vio el líder.
 */

const OFF_SCHEDULE: ReviewReason = 'exit:off-schedule';

/** Motivos que siguen sin revisar. */
export function pendingReview(reasons: readonly string[], reviewed: readonly string[]): string[] {
  return reasons.filter((r) => !reviewed.includes(r));
}

/** ¿Queda algo por revisar? */
export const needsReview = (reasons: readonly string[], reviewed: readonly string[]) =>
  pendingReview(reasons, reviewed).length > 0;

/**
 * Al corregir la salida se vuelve a decidir la regla 8 con la hora nueva: si ya no difiere del
 * horario, el motivo se quita (y su revisión con él); si ahora difiere, se agrega. Los motivos de
 * ubicación no cambian: la corrección no mueve dónde marcó.
 */
export function withOffSchedule(
  reasons: readonly string[],
  reviewed: readonly string[],
  offSchedule: boolean,
): { reviewReasons: string[]; reviewedReasons: string[] } {
  const base = reasons.filter((r) => r !== OFF_SCHEDULE);
  const reviewReasons = offSchedule ? [...base, OFF_SCHEDULE] : base;
  return {
    reviewReasons,
    reviewedReasons: reviewed.filter((r) => reviewReasons.includes(r)),
  };
}
