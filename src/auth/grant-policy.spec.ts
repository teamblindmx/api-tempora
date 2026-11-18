import { describe, expect, it } from 'vitest';
import { canGrant, grantorLevel } from './grant-policy.js';

const site = { type: 'site', companyId: 'c1', businessId: 'b1', siteId: 's1' } as const;

describe('grantorLevel', () => {
  it('toma el nivel más alto que alcanza el lugar', () => {
    expect(grantorLevel([{ type: 'site', id: 's1' }], site)).toBe('site');
    expect(
      grantorLevel(
        [
          { type: 'site', id: 's1' },
          { type: 'business', id: 'b1' },
        ],
        site,
      ),
    ).toBe('business');
    expect(grantorLevel([{ type: 'company', id: 'c1' }], site)).toBe('company');
    expect(grantorLevel([{ type: 'global' }], site)).toBe('global');
  });
  it('no cuenta alcances de otro lugar', () => {
    expect(
      grantorLevel(
        [
          { type: 'site', id: 's2' },
          { type: 'company', id: 'c2' },
          { type: 'business', id: 'b2' },
        ],
        site,
      ),
    ).toBeNull();
  });
});

describe('canGrant', () => {
  it('un líder de sede solo otorga trabajador y encargado', () => {
    expect(canGrant('site', ['worker'])).toBe(true);
    expect(canGrant('site', ['acting-leader'])).toBe(true);
    expect(canGrant('site', ['leader'])).toBe(false);
    expect(canGrant('site', ['worker', 'leader'])).toBe(false);
    expect(canGrant('site', ['company-admin'])).toBe(false);
  });
  it('un administrador de negocio otorga hasta líder y administrador de negocio', () => {
    expect(canGrant('business', ['leader', 'business-admin'])).toBe(true);
    expect(canGrant('business', ['company-admin'])).toBe(false);
  });
  it('un rol desconocido exige nivel de compañía', () => {
    expect(canGrant('business', ['rol-a-mano'])).toBe(false);
    expect(canGrant('company', ['rol-a-mano'])).toBe(true);
  });
  it('sin autoridad no se otorga nada', () => {
    expect(canGrant(null, ['worker'])).toBe(false);
  });
});
