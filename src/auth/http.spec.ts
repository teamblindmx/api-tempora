import { describe, expect, it } from 'vitest';
import { isCrossSiteWrite } from './http.js';

const trusted = new Set(['https://app.tempora.mx']);

describe('isCrossSiteWrite', () => {
  it('las lecturas nunca cuentan', () => {
    expect(isCrossSiteWrite('GET', { cookie: 'x=1', origin: 'https://malo.com' }, trusted)).toBe(false);
  });
  it('sin cookie no hay credencial que robar', () => {
    expect(isCrossSiteWrite('POST', { origin: 'https://malo.com' }, trusted)).toBe(false);
  });
  it('con cookie, el origen debe ser de confianza', () => {
    expect(isCrossSiteWrite('POST', { cookie: 'x=1', origin: 'https://app.tempora.mx' }, trusted)).toBe(
      false,
    );
    expect(isCrossSiteWrite('POST', { cookie: 'x=1', origin: 'https://malo.com' }, trusted)).toBe(true);
    expect(isCrossSiteWrite('DELETE', { cookie: 'x=1' }, trusted)).toBe(true);
    expect(isCrossSiteWrite('PATCH', { cookie: 'x=1', origin: 'null' }, trusted)).toBe(true);
  });
});
