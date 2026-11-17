/** Radio por defecto de una sede, en metros (regla 4). */
export const DEFAULT_RADIUS_M = 500;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia en metros sobre la superficie terrestre (haversine). */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type LocationCheck =
  | { status: 'ok'; distanceM: number }
  | { status: 'review'; reason: 'outside-radius'; distanceM: number }
  | { status: 'review'; reason: 'no-location'; distanceM: null };

/**
 * Reglas 3 y 4: dentro del radio, bien; fuera o sin ubicación, "por revisar". Nunca se rechaza.
 * Se devuelve la distancia real para guardarla y afinar el radio.
 */
export function checkLocation(
  site: Coordinates & { radiusM: number },
  at: Coordinates | null,
): LocationCheck {
  if (!at) return { status: 'review', reason: 'no-location', distanceM: null };
  const distanceM = Math.round(distanceMeters(site, at));
  return distanceM <= site.radiusM
    ? { status: 'ok', distanceM }
    : { status: 'review', reason: 'outside-radius', distanceM };
}
