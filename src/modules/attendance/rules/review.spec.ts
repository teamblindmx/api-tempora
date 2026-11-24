import { describe, expect, it } from 'vitest';
import { needsReview, pendingReview, withOffSchedule } from './review.js';

describe('revisión', () => {
  it('queda por revisar lo que tiene motivo y no se ha revisado', () => {
    expect(needsReview([], [])).toBe(false);
    expect(needsReview(['entry:outside-radius'], [])).toBe(true);
    expect(needsReview(['entry:outside-radius'], ['entry:outside-radius'])).toBe(false);
  });

  it('un motivo nuevo después de revisar vuelve a pedir revisión', () => {
    const reasons = ['entry:outside-radius', 'exit:no-location'];
    expect(pendingReview(reasons, ['entry:outside-radius'])).toEqual(['exit:no-location']);
  });

  it('al corregir la salida se vuelve a decidir "fuera de horario"', () => {
    expect(withOffSchedule(['entry:no-location', 'exit:off-schedule'], ['exit:off-schedule'], false)).toEqual(
      {
        reviewReasons: ['entry:no-location'],
        reviewedReasons: [],
      },
    );
    expect(withOffSchedule(['entry:no-location'], ['entry:no-location'], true)).toEqual({
      reviewReasons: ['entry:no-location', 'exit:off-schedule'],
      reviewedReasons: ['entry:no-location'],
    });
    // Seguía fuera de horario: la revisión que ya tenía se conserva.
    expect(withOffSchedule(['exit:off-schedule'], ['exit:off-schedule'], true)).toEqual({
      reviewReasons: ['exit:off-schedule'],
      reviewedReasons: ['exit:off-schedule'],
    });
  });
});
