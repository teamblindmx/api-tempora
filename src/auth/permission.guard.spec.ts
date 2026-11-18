import { describe, expect, it } from 'vitest';
import { grantsFromTenant } from './permission.guard.js';

const site = { type: 'site', companyId: 'c1', businessId: 'b1', siteId: 's1' } as const;
const company = { type: 'company', companyId: 'c1' } as const;

describe('grantsFromTenant', () => {
  it('una asignación global nunca cuenta para datos de clientes', () => {
    expect(grantsFromTenant({ type: 'global' }, site)).toBe(false);
  });
  it('la compañía cuenta en sus sedes; otra compañía no', () => {
    expect(grantsFromTenant({ type: 'company', id: 'c1' }, site)).toBe(true);
    expect(grantsFromTenant({ type: 'company', id: 'c2' }, site)).toBe(false);
  });
  it('el negocio cuenta en sus sedes', () => {
    expect(grantsFromTenant({ type: 'business', id: 'b1' }, site)).toBe(true);
    expect(grantsFromTenant({ type: 'business', id: 'b2' }, site)).toBe(false);
  });
  it('la sede solo cuenta en esa sede, nunca en la compañía entera', () => {
    expect(grantsFromTenant({ type: 'site', id: 's1' }, site)).toBe(true);
    expect(grantsFromTenant({ type: 'site', id: 's2' }, site)).toBe(false);
    expect(grantsFromTenant({ type: 'site', id: 's1' }, company)).toBe(false);
  });
});
