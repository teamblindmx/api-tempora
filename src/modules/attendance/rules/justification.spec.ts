import { describe, expect, it } from 'vitest';
import { justificationProblem } from './justification.js';

const base = { workDate: '2026-12-01', today: '2026-12-02', workday: true };

describe('justificationProblem (regla 12, versión simple)', () => {
  it('un retardo se justifica si la jornada es retardo', () => {
    expect(
      justificationProblem({ ...base, kind: 'late', record: { late: true, checkOutKind: null } }),
    ).toBeNull();
    expect(justificationProblem({ ...base, kind: 'late', record: { late: false, checkOutKind: null } })).toBe(
      'not-late',
    );
    expect(justificationProblem({ ...base, kind: 'late', record: null })).toBe('no-record');
  });

  it('una salida anticipada, si la salida fue anticipada', () => {
    expect(
      justificationProblem({ ...base, kind: 'early-exit', record: { late: false, checkOutKind: 'early' } }),
    ).toBeNull();
    expect(
      justificationProblem({ ...base, kind: 'early-exit', record: { late: false, checkOutKind: 'regular' } }),
    ).toBe('not-early-exit');
  });

  it('una falta: día laborable ya pasado y sin jornada', () => {
    expect(justificationProblem({ ...base, kind: 'absence', record: null })).toBeNull();
    expect(
      justificationProblem({ ...base, kind: 'absence', record: { late: false, checkOutKind: null } }),
    ).toBe('has-record');
    expect(justificationProblem({ ...base, kind: 'absence', record: null, workday: false })).toBe(
      'not-workday',
    );
    expect(justificationProblem({ ...base, kind: 'absence', record: null, workDate: '2026-12-02' })).toBe(
      'future',
    );
  });

  it('ni en el futuro ni de hace más de 31 días', () => {
    const rec = { late: true, checkOutKind: null };
    expect(justificationProblem({ ...base, kind: 'late', record: rec, workDate: '2026-12-03' })).toBe(
      'future',
    );
    expect(justificationProblem({ ...base, kind: 'late', record: rec, workDate: '2026-10-31' })).toBe(
      'too-old',
    );
    expect(justificationProblem({ ...base, kind: 'late', record: rec, workDate: '2026-11-01' })).toBeNull();
  });
});
