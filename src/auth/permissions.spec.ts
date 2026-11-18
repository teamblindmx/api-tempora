import { describe, expect, it } from 'vitest';
import { GRANT_POLICY, PERMISSIONS, ROLES } from './permissions.js';

describe('roles', () => {
  it('hay cinco roles de Tempora (el dueño de la plataforma es el administrador global de Axeda)', () => {
    expect(Object.keys(ROLES).toSorted()).toEqual([
      'acting-leader',
      'business-admin',
      'company-admin',
      'leader',
      'worker',
    ]);
  });

  it('el encargado solo tiene permisos que el líder ya tiene', () => {
    const leader = new Set<string>(ROLES.leader.permissions);
    for (const p of ROLES['acting-leader'].permissions) expect(leader.has(p), p).toBe(true);
  });

  it('el trabajador no ve asistencia de otros ni autoriza horas extra', () => {
    const worker: readonly string[] = ROLES.worker.permissions;
    expect(worker).not.toContain(PERMISSIONS.attendanceRead);
    expect(worker).not.toContain(PERMISSIONS.overtimeAuthorize);
  });

  it('ni el encargado ni el trabajador pueden otorgar roles', () => {
    for (const role of [ROLES['acting-leader'], ROLES.worker]) {
      expect(role.permissions.some((p: string) => p.startsWith('axeda:'))).toBe(false);
    }
  });

  it('el líder cubre los permisos del trabajador y del encargado (Axeda lo exige para otorgarlos)', () => {
    const leader = new Set<string>(ROLES.leader.permissions);
    for (const p of [...ROLES.worker.permissions, ...ROLES['acting-leader'].permissions])
      expect(leader.has(p), p).toBe(true);
  });

  it('todo rol tiene una regla de quién lo otorga', () => {
    expect(Object.keys(GRANT_POLICY).toSorted()).toEqual(Object.keys(ROLES).toSorted());
  });
});
