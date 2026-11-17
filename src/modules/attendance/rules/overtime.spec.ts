import { describe, expect, it } from 'vitest';
import { splitWeeklyOvertime } from './overtime.js';

describe('splitWeeklyOvertime', () => {
  it('hasta 3 al día son dobles', () => {
    expect(splitWeeklyOvertime([2, 3])).toEqual([
      { double: 2, triple: 0 },
      { double: 3, triple: 0 },
    ]);
  });
  it('más de 3 en un día pasan a triples', () => {
    expect(splitWeeklyOvertime([4.5])).toEqual([{ double: 3, triple: 1.5 }]);
  });
  it('después de 9 dobles en la semana, todo es triple', () => {
    expect(splitWeeklyOvertime([3, 3, 3, 2])).toEqual([
      { double: 3, triple: 0 },
      { double: 3, triple: 0 },
      { double: 3, triple: 0 },
      { double: 0, triple: 2 },
    ]);
    expect(splitWeeklyOvertime([3, 3, 2, 3])[3]).toEqual({ double: 1, triple: 2 });
  });
  it('rechaza horas negativas', () => {
    expect(() => splitWeeklyOvertime([-1])).toThrow(RangeError);
  });
});
