import type { IncomingHttpHeaders } from 'node:http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cabeceras de Node → Headers de la API web (lo que espera Better Auth). */
export function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  return headers;
}

/**
 * ¿Es una escritura entre sitios? Solo importa si viaja con cookie (la credencial que el navegador
 * adjunta solo). Con cookie, el Origin debe ser de confianza; si falta o es "null", se rechaza.
 * Mismo criterio que @teamblind/axeda-express.
 */
export function isCrossSiteWrite(
  method: string,
  headers: { cookie?: string | undefined; origin?: string | string[] | undefined },
  trusted: ReadonlySet<string>,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (!headers.cookie) return false;
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (!origin || origin === 'null') return true;
  return !trusted.has(origin);
}
