import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CLIENT_IP_HEADER, clientIpMiddleware, parseTrustProxy } from './client-ip.js';

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 192.168.1.4', ['10.0.0.0/8', '192.168.1.4']],
    ['fd00::/8,loopback', ['fd00::/8', 'loopback']],
  ])('%s', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it.each(['0', '11', 'si', '10.0.0.0/33', '300.1.1.1', 'loopback,,x', '1.2.3.4/8/2'])(
    'rechaza %s',
    (raw) => {
      expect(parseTrustProxy(raw)).toBeNull();
    },
  );
});

const run = (ip: string | undefined, headers: Record<string, string>) => {
  const req = { ip, headers: { ...headers } } as unknown as Request;
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  clientIpMiddleware(req, {} as Response, next);
  return { headers: req.headers, called };
};

describe('clientIpMiddleware', () => {
  it('pone la IP que resolvió Express y descarta la del cliente', () => {
    const r = run('203.0.113.7', { [CLIENT_IP_HEADER]: '1.1.1.1' });
    expect(r.headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
    expect(r.called).toBe(true);
  });

  it('sin IP conocida no deja ninguna', () => {
    const r = run(undefined, { [CLIENT_IP_HEADER]: '1.1.1.1' });
    expect(r.headers[CLIENT_IP_HEADER]).toBeUndefined();
  });
});
