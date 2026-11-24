import { describe, expect, it, vi } from 'vitest';
import { MailSendError, resendMailer } from './resend.js';

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const link = 'https://app.tempora.mx/invitacion?token=abc.def&x=<1>';

describe('resendMailer', () => {
  it('manda la invitación por la API de Resend con el enlace en texto y HTML', async () => {
    const f = fakeFetch(200, { id: 'e1' });
    await resendMailer({
      apiKey: 're_secreta',
      from: 'Tempora <no-responder@tempora.mx>',
      fetch: f,
    }).sendInvitationEmail('ana@example.com', link);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_secreta');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      from: 'Tempora <no-responder@tempora.mx>',
      to: ['ana@example.com'],
      subject: 'Tempora: te invitaron',
    });
    expect(body.text).toContain(link);
    // En el HTML el enlace va escapado: no se puede inyectar marcado.
    expect(body.html).toContain('token=abc.def&amp;x=&lt;1&gt;');
    expect(body.html).not.toContain('<1>');
    expect(body).not.toHaveProperty('reply_to');
  });

  it('la verificación lleva su propio asunto y, si se da, la dirección de respuesta', async () => {
    const f = fakeFetch(200);
    await resendMailer({
      apiKey: 're_x',
      from: 'no-responder@tempora.mx',
      replyTo: 'soporte@tempora.mx',
      fetch: f,
    }).sendVerificationEmail('ana@example.com', 'https://api.tempora.mx/api/auth/verify-email?token=t');
    const body = JSON.parse(f.mock.calls[0]![1]?.body as string);
    expect(body.subject).toBe('Tempora: confirma tu correo');
    expect(body.reply_to).toBe('soporte@tempora.mx');
    expect(body.text).toContain('verify-email?token=t');
  });

  it('convierte un rechazo de Resend en MailSendError con su tipo, sin el destino', async () => {
    const f = fakeFetch(422, {
      statusCode: 422,
      name: 'validation_error',
      message: 'Invalid `to` ana@example.com',
    });
    const err = await resendMailer({ apiKey: 're_x', from: 'a@tempora.mx', fetch: f })
      .sendInvitationEmail('ana@example.com', link)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ status: 422, code: 'validation_error' });
    expect((err as Error).message).not.toMatch(/ana@example\.com|token/);
  });

  it('no manda nada a un correo de relleno de quien entró por teléfono', async () => {
    const f = fakeFetch(200);
    await resendMailer({ apiKey: 're_x', from: 'a@tempora.mx', fetch: f }).sendVerificationEmail(
      '5213312345678@phone.invalid',
      link,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('un fallo de red también es MailSendError', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      resendMailer({ apiKey: 're_x', from: 'a@tempora.mx', fetch: f }).sendInvitationEmail('a@b.mx', link),
    ).rejects.toBeInstanceOf(MailSendError);
  });
});
