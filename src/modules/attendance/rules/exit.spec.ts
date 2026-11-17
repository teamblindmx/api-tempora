import { describe, expect, it } from 'vitest';
import { exitKind, exitNeedsReview } from './exit.js';

const end = new Date('2026-11-17T23:00:00Z'); // 17:00 en CDMX

describe('exitKind', () => {
  it('antes de la ventana: anticipada', () => {
    expect(exitKind(new Date('2026-11-17T22:29:59Z'), end)).toBe('early');
  });
  it('desde 30 minutos antes y después del cierre: normal', () => {
    expect(exitKind(new Date('2026-11-17T22:30:00Z'), end)).toBe('regular');
    expect(exitKind(new Date('2026-11-18T01:00:00Z'), end)).toBe('regular');
  });
});

describe('exitNeedsReview', () => {
  it('hasta 30 minutos de diferencia no se revisa', () => {
    expect(exitNeedsReview(new Date('2026-11-17T23:30:00Z'), end, false)).toBe(false);
    expect(exitNeedsReview(new Date('2026-11-17T22:30:00Z'), end, false)).toBe(false);
  });
  it('más de 30 minutos sin autorización: por revisar', () => {
    expect(exitNeedsReview(new Date('2026-11-17T23:31:00Z'), end, false)).toBe(true);
  });
  it('con autorización no se revisa', () => {
    expect(exitNeedsReview(new Date('2026-11-18T02:00:00Z'), end, true)).toBe(false);
  });
});
