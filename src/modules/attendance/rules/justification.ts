import { addDays } from './workday.js';

/**
 * Justificaciones (regla 12, versión simple para el piloto): el trabajador escribe por qué llegó
 * tarde, salió antes o faltó, y el líder la aprueba o la rechaza. La disputa con Recursos Humanos
 * llega después del 1 de enero. Una justificación no borra el retardo: lo explica.
 */

export const JUSTIFICATION_KINDS = ['late', 'early-exit', 'absence'] as const;
export const JUSTIFICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type JustificationKind = (typeof JUSTIFICATION_KINDS)[number];
export type JustificationStatus = (typeof JUSTIFICATION_STATUSES)[number];

/** Lo que viene de la columna de texto (la base ya lo restringe con CHECK). */
export function asKind(s: string): JustificationKind {
  const k = JUSTIFICATION_KINDS.find((x) => x === s);
  if (!k) throw new RangeError(`Tipo de justificación desconocido: ${s}`);
  return k;
}
export function asStatus(s: string): JustificationStatus {
  const k = JUSTIFICATION_STATUSES.find((x) => x === s);
  if (!k) throw new RangeError(`Estado de justificación desconocido: ${s}`);
  return k;
}

/** Días hacia atrás que se pueden justificar (una quincena y algo). */
export const JUSTIFICATION_MAX_DAYS_BACK = 31;

export type JustificationProblem =
  'future' | 'too-old' | 'not-late' | 'not-early-exit' | 'has-record' | 'no-record' | 'not-workday';

export interface JustificationInput {
  kind: JustificationKind;
  workDate: string;
  today: string;
  /** La jornada de ese día, si existe. */
  record: { late: boolean; checkOutKind: string | null } | null;
  /** ¿Era día laborable? Una falta en un descanso o festivo no se justifica. */
  workday: boolean;
}

/** ¿Tiene sentido esta justificación? null si sí. */
export function justificationProblem(input: JustificationInput): JustificationProblem | null {
  if (input.workDate > input.today) return 'future';
  if (input.workDate < addDays(input.today, -JUSTIFICATION_MAX_DAYS_BACK)) return 'too-old';
  switch (input.kind) {
    case 'late':
      if (!input.record) return 'no-record';
      return input.record.late ? null : 'not-late';
    case 'early-exit':
      if (!input.record) return 'no-record';
      return input.record.checkOutKind === 'early' ? null : 'not-early-exit';
    case 'absence':
    default:
      if (input.record) return 'has-record';
      // Una falta es de un día que ya pasó: hoy todavía puede llegar.
      if (input.workDate === input.today) return 'future';
      return input.workday ? null : 'not-workday';
  }
}
