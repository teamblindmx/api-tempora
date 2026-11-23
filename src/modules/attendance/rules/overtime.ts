/** Tope de horas extra dobles (regla 15, pendiente de validar con un laboralista). */
export const DOUBLE_PER_DAY = 3;
export const DOUBLE_PER_WEEK = 9;

export interface OvertimeSplit {
  double: number;
  triple: number;
}

/**
 * Regla 15: separa las horas extra de cada día de una semana en dobles y triples. Dobles hasta
 * 3 por día y 9 por semana; el resto, triples. Recibe los días en orden. Solo horas, no dinero.
 */
export function splitWeeklyOvertime(extraHoursByDay: readonly number[]): OvertimeSplit[] {
  let weekDouble = 0;
  return extraHoursByDay.map((hours) => {
    if (!Number.isFinite(hours) || hours < 0) throw new RangeError(`Horas extra inválidas: ${hours}`);
    const double = Math.min(hours, DOUBLE_PER_DAY, Math.max(0, DOUBLE_PER_WEEK - weekDouble));
    weekDouble += double;
    return { double, triple: hours - double };
  });
}

const MIN = 60_000;

/** Autorización de horas extra de un día, como la necesita el cálculo. */
export interface OvertimeWindow {
  /** Hasta qué hora; null: jornada abierta. */
  until: Date | null;
  /** Cuándo la cerró el líder; null si sigue abierta. */
  closedAt: Date | null;
}

export interface OvertimeMinutes {
  /** Minutos después del cierre oficial. */
  extraMinutes: number;
  /** De esos, los que cubre la autorización. */
  authorizedMinutes: number;
  /** El resto: "tiempo no autorizado" para revisión (regla 9). Se trabajó, así que se reporta. */
  unauthorizedMinutes: number;
}

/** Hasta cuándo vale una autorización: lo que llegue primero entre `until` y el cierre del líder. */
export function authorizedEnd(w: OvertimeWindow): Date | null {
  const ends = [w.until, w.closedAt].filter((d): d is Date => d !== null);
  return ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null;
}

/**
 * Regla 9: tiempo después del cierre oficial, separado en autorizado y no autorizado. Se cuenta solo
 * lo posterior al cierre (llegar antes no es hora extra). `exitAt` es la salida, o "ahora" si la
 * jornada sigue abierta. Dobles y triples (regla 15) se separan después, con splitWeeklyOvertime.
 */
export function overtimeMinutes(
  scheduledEnd: Date,
  exitAt: Date,
  auth: OvertimeWindow | null,
): OvertimeMinutes {
  const extraMinutes = Math.max(0, Math.floor((exitAt.getTime() - scheduledEnd.getTime()) / MIN));
  if (!auth) return { extraMinutes, authorizedMinutes: 0, unauthorizedMinutes: extraMinutes };
  const end = authorizedEnd(auth);
  const coveredUntil = end ? Math.min(end.getTime(), exitAt.getTime()) : exitAt.getTime();
  const authorizedMinutes = Math.min(
    extraMinutes,
    Math.max(0, Math.floor((coveredUntil - scheduledEnd.getTime()) / MIN)),
  );
  return { extraMinutes, authorizedMinutes, unauthorizedMinutes: extraMinutes - authorizedMinutes };
}
