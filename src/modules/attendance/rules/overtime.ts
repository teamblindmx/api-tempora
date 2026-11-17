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
