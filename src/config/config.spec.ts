import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://tempora_app:app@localhost:5432/tempora',
  DATABASE_URL_AUTH: 'postgresql://tempora_auth:auth@localhost:5432/tempora',
  BETTER_AUTH_SECRET: 'x'.repeat(16) + 'y'.repeat(16) + 'z',
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://localhost:5173, http://localhost:4173',
};

describe('loadConfig', () => {
  it('acepta una configuración completa y aplica valores por omisión no secretos', () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.TRUSTED_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    expect(c.COOKIE_DOMAIN).toBeUndefined();
  });

  it.each(['DATABASE_URL', 'DATABASE_URL_AUTH', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'TRUSTED_ORIGINS'])(
    'falla si falta %s',
    (key) => {
      const env: Record<string, string> = { ...valid };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(key);
    },
  );

  it('rechaza un secreto corto', () => {
    expect(() => loadConfig({ ...valid, BETTER_AUTH_SECRET: 'corto' })).toThrow(/32 caracteres/);
  });

  it('exige https en producción', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/https/);
    expect(
      loadConfig({ ...valid, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://api.tempora.mx' }).NODE_ENV,
    ).toBe('production');
  });
});
