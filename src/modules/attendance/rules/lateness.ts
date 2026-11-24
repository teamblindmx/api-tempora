import { type Shift, zonedTime } from './workday.js';

/**
 * Retardos (regla 10 y pregunta abierta 4 del PRD). Se decide al registrar la entrada, con el
 * horario y la tolerancia de la sede en ese momento, y se guarda: si después cambia la tolerancia,
 * los retardos ya registrados no cambian. Solo se registra el hecho; las sanciones las decide
 * nómina o un laboralista (pendientes legales, 4).
 */

/** Tolerancia por omisión (el PRD dice "10 o 15 minutos"; ADR 0014). */
export const DEFAULT_LATE_TOLERANCE_MIN = 10;
export const MAX_LATE_TOLERANCE_MIN = 120;

const MIN = 60_000;

export interface LatenessInput {
  checkInAt: Date;
  /** Día de jornada, "YYYY-MM-DD" en la zona de la sede. */
  workDate: string;
  shift: Shift | null;
  timeZone: string;
  toleranceMin: number;
  /** ¿Se esperaba que trabajara ese día? En un descanso o festivo no hay retardo. */
  workday: boolean;
  /** Entró con "Registrar entrada tardía" (código de hoy ya vencido). */
  codeExpired: boolean;
}

export interface Lateness {
  late: boolean;
  /** Minutos después de la entrada oficial (0 si llegó antes). Null sin horario. */
  minutesAfterStart: number | null;
}

/**
 * Hay retardo si la entrada pasa de la entrada oficial más la tolerancia (llegar justo al límite no
 * es retardo). Sin horario en la sede, la única señal es la entrada con código vencido.
 */
export function evaluateLateness(input: LatenessInput): Lateness {
  const minutesAfterStart = input.shift
    ? Math.max(
        0,
        Math.floor(
          (input.checkInAt.getTime() -
            zonedTime(input.workDate, input.shift.start, input.timeZone).getTime()) /
            MIN,
        ),
      )
    : null;
  if (!input.workday) return { late: false, minutesAfterStart };
  const late = minutesAfterStart === null ? input.codeExpired : minutesAfterStart > input.toleranceMin;
  return { late, minutesAfterStart };
}
