import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRONTEND, startApp, type TestApp } from './helpers.js';

/**
 * Semana 8 (ADR 0016): una API sin proxy de confianza (TRUST_PROXY vacío) usa la IP del socket.
 * Archivo aparte porque las pruebas e2e comparten TRUST_PROXY=true y una app por archivo.
 */

let t: TestApp;

beforeAll(async () => {
  t = await startApp({ TRUST_PROXY: '' });
});
afterAll(async () => {
  await t?.close();
});

describe('Sin proxy de confianza', () => {
  it('ni X-Forwarded-For ni la cabecera interna sirven para saltarse el tope de inicios de sesión', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const spoof =
        i % 2 ? { 'X-Forwarded-For': `198.51.100.${i}` } : { 'X-Tempora-Client-Ip': `192.0.2.${i}` };
      const res = await request(t.server)
        .post('/api/auth/sign-in/email')
        .set('Origin', FRONTEND)
        .set(spoof)
        .send({ email: `nadie.${i}@example.com`, password: 'contraseña-incorrecta-123' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
