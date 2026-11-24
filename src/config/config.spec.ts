import { describe, expect, it } from 'vitest';
import { appUrl, ConfigError, loadConfig } from './config.js';

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

  it('TRUST_PROXY: por omisión no hay proxy; acepta saltos y rangos', () => {
    expect(loadConfig(valid).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...valid, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toEqual(['10.0.0.0/8']);
    expect(() => loadConfig({ ...valid, TRUST_PROXY: 'quizá' })).toThrow(/TRUST_PROXY/);
  });

  it('rechaza un secreto corto', () => {
    expect(() => loadConfig({ ...valid, BETTER_AUTH_SECRET: 'corto' })).toThrow(/32 caracteres/);
  });

  it('exige https en producción', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/https/);
  });

  /** Lo mínimo para que producción arranque con correo de verdad (Resend). */
  const resend = {
    MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_1234567890abcdef',
    MAIL_FROM: 'Tempora <no-responder@tempora.mx>',
  };

  it('en producción no acepta el SMS de consola', () => {
    expect(() =>
      loadConfig({ ...valid, ...resend, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://api.tempora.mx' }),
    ).toThrow(/SMS_PROVIDER/);
  });

  describe('Resend', () => {
    it('en producción no acepta el correo de consola', () => {
      expect(() =>
        loadConfig({
          ...valid,
          NODE_ENV: 'production',
          BETTER_AUTH_URL: 'https://api.tempora.mx',
          SMS_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
          TWILIO_AUTH_TOKEN: 'b'.repeat(32),
          TWILIO_FROM: '+15005550006',
        }),
      ).toThrow(/MAIL_PROVIDER/);
    });

    it('acepta la llave y el remitente, con o sin nombre', () => {
      expect(loadConfig({ ...valid, ...resend }).MAIL_PROVIDER).toBe('resend');
      expect(() => loadConfig({ ...valid, ...resend, MAIL_FROM: 'no-responder@tempora.mx' })).not.toThrow();
    });

    it.each(['RESEND_API_KEY', 'MAIL_FROM'])('falla si falta %s', (key) => {
      expect(() => loadConfig({ ...valid, ...resend, [key]: '' })).toThrow(key);
    });

    it('rechaza una llave o un remitente con formato incorrecto', () => {
      expect(() => loadConfig({ ...valid, ...resend, RESEND_API_KEY: 'sk_123' })).toThrow(/RESEND_API_KEY/);
      expect(() => loadConfig({ ...valid, ...resend, MAIL_FROM: 'Tempora' })).toThrow(/MAIL_FROM/);
      expect(() => loadConfig({ ...valid, ...resend, MAIL_REPLY_TO: 'no' })).toThrow(/MAIL_REPLY_TO/);
    });
  });

  describe('Twilio', () => {
    const twilio = {
      ...valid,
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
      TWILIO_AUTH_TOKEN: 'b'.repeat(32),
      TWILIO_FROM: '+15005550006',
    };

    it('acepta credenciales completas y sirve en producción', () => {
      const c = loadConfig({
        ...twilio,
        ...resend,
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://api.tempora.mx',
      });
      expect(c.SMS_PROVIDER).toBe('twilio');
      expect(c.TWILIO_API_KEY_SID).toBeUndefined();
    });

    it('acepta un Messaging Service en lugar de número remitente', () => {
      expect(() =>
        loadConfig({ ...twilio, TWILIO_FROM: '', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32) }),
      ).not.toThrow();
    });

    it.each(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'])('falla si falta %s', (key) => {
      expect(() => loadConfig({ ...twilio, [key]: '' })).toThrow(key);
    });

    it('rechaza un SID con formato incorrecto', () => {
      expect(() => loadConfig({ ...twilio, TWILIO_ACCOUNT_SID: 'AC123' })).toThrow(/TWILIO_ACCOUNT_SID/);
    });
  });

  it('la URL del frontend sale de APP_URL o del primer origen de confianza', () => {
    expect(appUrl(loadConfig(valid))).toBe('http://localhost:5173');
    expect(appUrl(loadConfig({ ...valid, APP_URL: 'https://app.tempora.mx' }))).toBe(
      'https://app.tempora.mx',
    );
  });
});
