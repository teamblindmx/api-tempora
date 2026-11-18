import { type ExitKind, exitKind, exitNeedsReview } from './exit.js';
import type { LocationCheck } from './location.js';
import { addDays, crossesMidnight, type Shift } from './workday.js';

/** Duración permitida de un código diario, en minutos (regla 2). */
export const DAILY_CODE_MIN_TTL = 20;
export const DAILY_CODE_MAX_TTL = 30;
export const DAILY_CODE_DEFAULT_TTL = 30;
/** Dígitos del código: corto, para dictarlo o copiarlo de un pizarrón. */
export const DAILY_CODE_DIGITS = 6;

/**
 * Motivos por los que un registro queda "por revisar". Nunca se rechaza un marcado por estos
 * motivos (regla 3): se guarda y el líder lo revisa.
 */
export type ReviewReason =
  | 'entry:no-location'
  | 'entry:outside-radius'
  | 'exit:no-location'
  | 'exit:outside-radius'
  /** Regla 8: la salida difiere más de 30 minutos del cierre y no hay autorización. */
  | 'exit:off-schedule';

export function locationReview(stage: 'entry' | 'exit', check: LocationCheck): ReviewReason[] {
  return check.status === 'ok' ? [] : [`${stage}:${check.reason}`];
}

export interface CheckOutInput {
  now: Date;
  /** Cierre oficial del turno, o null si la sede no tiene horario configurado. */
  scheduledEnd: Date | null;
  /** Horas extra autorizadas para ese día (llega con el flujo de horas extra; hoy siempre false). */
  overtimeAuthorized: boolean;
  location: LocationCheck;
  reason: string | null;
}

export type CheckOutResult =
  | { ok: true; kind: ExitKind; reviewReasons: ReviewReason[] }
  | { ok: false; error: 'early-exit-reason-required' };

/**
 * Reglas 6 y 8 sobre una salida. Sin horario configurado, toda salida es normal y no se revisa por
 * horario (pregunta abierta 4 del PRD: falta el horario oficial de cada sede).
 */
export function evaluateCheckOut(input: CheckOutInput): CheckOutResult {
  const reviewReasons = locationReview('exit', input.location);
  if (!input.scheduledEnd) return { ok: true, kind: 'regular', reviewReasons };
  const kind = exitKind(input.now, input.scheduledEnd);
  if (kind === 'early' && !input.reason) return { ok: false, error: 'early-exit-reason-required' };
  if (exitNeedsReview(input.now, input.scheduledEnd, input.overtimeAuthorized)) {
    reviewReasons.push('exit:off-schedule');
  }
  return { ok: true, kind, reviewReasons };
}

/**
 * Regla 7: el trabajador solo cierra la jornada de hoy (o la de ayer si su turno cruza la medianoche).
 * Una jornada más vieja sin salida queda como "salida pendiente" y la corrige el líder con comentario.
 */
export function canSelfCheckOut(workDate: string, today: string, shift: Shift | null): boolean {
  if (workDate === today) return true;
  return !!shift && crossesMidnight(shift) && addDays(workDate, 1) === today;
}

export type RecordStatus = 'open' | 'pending-exit' | 'closed';

/** Estado de una jornada para mostrarla: abierta, salida pendiente (regla 7) o cerrada. */
export function recordStatus(
  record: { workDate: string; checkOutAt: Date | null },
  today: string,
  shift: Shift | null,
): RecordStatus {
  if (record.checkOutAt) return 'closed';
  return canSelfCheckOut(record.workDate, today, shift) ? 'open' : 'pending-exit';
}
