import { MAX_WORKDAY_HOURS } from './manual.js';
import { addDays } from './workday.js';

/**
 * Corrección de horas de una jornada ya registrada (regla 13, ADR 0015). El líder corrige la hora de
 * entrada o de salida que quedó mal (el trabajador marcó tarde por falta de señal, el líder capturó
 * mal una hora manual). Siempre con comentario, con el valor anterior y el nuevo en el historial, y
 * nunca la propia. Agregar una salida que no existe no es una corrección: es el marcado manual.
 */

/** Días hacia atrás (en la zona de la sede) que se pueden corregir: un periodo de nómina largo. */
export const CORRECTION_MAX_DAYS_BACK = 31;

const HOUR = 3_600_000;

export type CorrectionProblem =
  'nothing-to-change' | 'no-exit' | 'too-old' | 'future' | 'other-day' | 'before-check-in' | 'too-long';

export interface CorrectionInput {
  record: { workDate: string; checkInAt: Date; checkOutAt: Date | null };
  /** Nueva hora de entrada, o null si no cambia. */
  checkInAt: Date | null;
  /** Nueva hora de salida, o null si no cambia. */
  checkOutAt: Date | null;
  /** Día local de la sede de la nueva entrada (la jornada no cambia de día). */
  checkInDate: string | null;
  now: Date;
  today: string;
}

export type CorrectionPlan =
  | {
      ok: true;
      checkInAt: Date;
      checkOutAt: Date | null;
      checkInChanged: boolean;
      checkOutChanged: boolean;
    }
  | { ok: false; problem: CorrectionProblem };

const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** ¿Se puede corregir así? Devuelve las horas finales y qué cambió. */
export function planCorrection(input: CorrectionInput): CorrectionPlan {
  const { record } = input;
  if (input.checkOutAt && !record.checkOutAt) return { ok: false, problem: 'no-exit' };
  if (record.workDate < addDays(input.today, -CORRECTION_MAX_DAYS_BACK)) {
    return { ok: false, problem: 'too-old' };
  }
  const checkInAt = input.checkInAt ?? record.checkInAt;
  const checkOutAt = input.checkOutAt ?? record.checkOutAt;
  const checkInChanged = !same(checkInAt, record.checkInAt);
  const checkOutChanged = !same(checkOutAt, record.checkOutAt);
  if (!checkInChanged && !checkOutChanged) return { ok: false, problem: 'nothing-to-change' };
  const now = input.now.getTime();
  if (checkInAt.getTime() > now || (checkOutAt && checkOutAt.getTime() > now)) {
    return { ok: false, problem: 'future' };
  }
  if (checkInChanged && input.checkInDate !== record.workDate) return { ok: false, problem: 'other-day' };
  if (checkOutAt && checkOutAt.getTime() < checkInAt.getTime()) {
    return { ok: false, problem: 'before-check-in' };
  }
  if (checkOutAt && checkOutAt.getTime() - checkInAt.getTime() > MAX_WORKDAY_HOURS * HOUR) {
    return { ok: false, problem: 'too-long' };
  }
  return { ok: true, checkInAt, checkOutAt, checkInChanged, checkOutChanged };
}
