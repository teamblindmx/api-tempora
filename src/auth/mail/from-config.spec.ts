import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { consoleMailer } from '../messaging.js';
import { mailerFromConfig } from './from-config.js';

const base = {
  DATABASE_URL: 'postgresql://tempora_app:app@localhost:5432/tempora',
  DATABASE_URL_AUTH: 'postgresql://tempora_auth:auth@localhost:5432/tempora',
  BETTER_AUTH_SECRET: 'x'.repeat(33),
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://localhost:5173',
};

afterEach(() => vi.unstubAllGlobals());

describe('mailerFromConfig', () => {
  it('en desarrollo usa la consola', () => {
    expect(mailerFromConfig(loadConfig(base))).toBe(consoleMailer);
  });

  it('con MAIL_PROVIDER=resend envía por la API de Resend', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const mailer = mailerFromConfig(
      loadConfig({
        ...base,
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_1234567890abcdef',
        MAIL_FROM: 'Tempora <no-responder@tempora.mx>',
      }),
    );
    await mailer.sendInvitationEmail('ana@example.com', 'https://app.tempora.mx/invitacion?token=t');
    expect(f.mock.calls[0]![0]).toBe('https://api.resend.com/emails');
  });
});
