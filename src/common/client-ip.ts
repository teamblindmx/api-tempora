import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * Cabecera interna con la IP del cliente que ya resolvió Express (según TRUST_PROXY). Better Auth
 * solo lee esta: la que mande el cliente se borra antes, así que nadie puede elegir su IP para
 * saltarse los topes de intentos (ADR 0016).
 */
export const CLIENT_IP_HEADER = 'x-tempora-client-ip';

/** Palabras que Express acepta en `trust proxy` además de IPs y rangos CIDR. */
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Valor de `trust proxy` de Express: no, todos, cuántos saltos, o qué direcciones. */
export type TrustProxy = boolean | number | string[];

const isAddressOrRange = (s: string) => {
  if (KEYWORDS.has(s)) return true;
  const [ip, bits, ...rest] = s.split('/');
  if (rest.length > 0 || !ip) return false;
  const v = isIP(ip);
  if (v === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v === 4 ? 32 : 128);
};

/**
 * Lee TRUST_PROXY: vacío o "false" = no hay proxy (la IP es la del socket); "true" = confiar en
 * todo X-Forwarded-For (solo si nadie llega directo a la API); un número = cuántos proxies hay
 * delante; o una lista separada por comas de IPs, rangos CIDR o loopback/linklocal/uniquelocal.
 * Devuelve null si no es válido.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy | null {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 10 ? n : null;
  }
  const list = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length > 0 && list.every(isAddressOrRange) ? list : null;
}

/** Middleware: reemplaza la cabecera interna por la IP que resolvió Express. Va antes de Better Auth. */
export function clientIpMiddleware(req: Request, _res: Response, next: NextFunction) {
  delete req.headers[CLIENT_IP_HEADER];
  if (req.ip) req.headers[CLIENT_IP_HEADER] = req.ip;
  next();
}
