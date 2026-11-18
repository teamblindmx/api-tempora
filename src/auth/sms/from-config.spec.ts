import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { consoleSms } from '../messaging.js';
import { smsFromConfig } from './from-config.js';

const base = {
  DATABASE_URL: 'postgresql://tempora_app:app@localhost:5432/tempora',
  DATABASE_URL_AUTH: 'postgresql://tempora_auth:auth@localhost:5432/tempora',
  BETTER_AUTH_SECRET: 'x'.repeat(33),
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://localhost:5173',
};

afterEach(() => vi.unstubAllGlobals());

describe('smsFromConfig', () => {
  it('en desarrollo usa la consola', () => {
    expect(smsFromConfig(loadConfig(base))).toBe(consoleSms);
  });

  it('con SMS_PROVIDER=twilio envía por la API de Twilio', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', f);
    const sid = 'AC' + 'a'.repeat(32);
    const sms = smsFromConfig(
      loadConfig({
        ...base,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: sid,
        TWILIO_AUTH_TOKEN: 'b'.repeat(32),
        TWILIO_FROM: '+15005550006',
      }),
    );
    await sms.send('+525512345678', 'hola');
    expect(f.mock.calls[0]![0]).toContain(`/Accounts/${sid}/Messages.json`);
  });
});
