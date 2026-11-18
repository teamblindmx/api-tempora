import type { AssignmentScope, TargetScope } from '@teamblind/axeda-core';
import { GRANT_POLICY, type GrantLevel, type RoleKey } from './permissions.js';

const RANK: Record<GrantLevel, number> = { site: 1, business: 2, company: 3, global: 4 };

/**
 * El nivel más alto desde el que `scopes` (donde la persona tiene el permiso de gestión) alcanza a
 * `target`. null si ninguno lo alcanza. Función pura.
 */
export function grantorLevel(scopes: readonly AssignmentScope[], target: TargetScope): GrantLevel | null {
  let best: GrantLevel | null = null;
  const consider = (level: GrantLevel) => {
    if (!best || RANK[level] > RANK[best]) best = level;
  };
  for (const s of scopes) {
    if (s.type === 'global') consider('global');
    else if (target.type === 'global') continue;
    else if (s.type === 'company' && s.id === target.companyId) consider('company');
    else if (s.type === 'business' && 'businessId' in target && target.businessId === s.id)
      consider('business');
    else if (s.type === 'site' && target.type === 'site' && target.siteId === s.id) consider('site');
  }
  return best;
}

const isRoleKey = (key: string): key is RoleKey => Object.hasOwn(GRANT_POLICY, key);

/**
 * ¿Puede alguien con autoridad `level` otorgar (o quitar) estos roles? Los roles que no declara
 * Tempora (creados a mano en Axeda) exigen nivel de compañía.
 */
export function canGrant(level: GrantLevel | null, roleKeys: readonly string[]): boolean {
  if (!level) return false;
  return roleKeys.every((key) => {
    const needed = isRoleKey(key) ? GRANT_POLICY[key] : 'company';
    return RANK[level] >= RANK[needed];
  });
}
