import { describe, expect, it } from 'vitest';
import { checkLocation, distanceMeters } from './location.js';

// Catedral de Guadalajara y Teatro Degollado: ~500 m.
const catedral = { latitude: 20.676667, longitude: -103.347222 };
const degollado = { latitude: 20.676944, longitude: -103.3425 };

describe('distanceMeters', () => {
  it('es cero en el mismo punto y simétrica', () => {
    expect(distanceMeters(catedral, catedral)).toBe(0);
    expect(distanceMeters(catedral, degollado)).toBeCloseTo(distanceMeters(degollado, catedral), 6);
  });
  it('da una distancia conocida con error menor a 1%', () => {
    // CDMX (Zócalo) a Guadalajara (Catedral): ~461 km en línea recta.
    const zocalo = { latitude: 19.432608, longitude: -99.133209 };
    expect(distanceMeters(zocalo, catedral) / 1000).toBeGreaterThan(456);
    expect(distanceMeters(zocalo, catedral) / 1000).toBeLessThan(466);
  });
});

describe('checkLocation', () => {
  const site = { ...catedral, radiusM: 500 };
  it('dentro del radio: ok, con la distancia', () => {
    expect(checkLocation(site, { latitude: 20.6768, longitude: -103.3474 })).toMatchObject({ status: 'ok' });
  });
  it('fuera del radio: por revisar, no rechazado', () => {
    const r = checkLocation({ ...site, radiusM: 100 }, degollado);
    expect(r).toMatchObject({ status: 'review', reason: 'outside-radius' });
    expect(r.distanceM).toBeGreaterThan(400);
  });
  it('sin ubicación: por revisar', () => {
    expect(checkLocation(site, null)).toEqual({ status: 'review', reason: 'no-location', distanceM: null });
  });
});
