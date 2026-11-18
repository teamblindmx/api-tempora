import { describe, expect, it, vi } from 'vitest';
import { SmsSendError, twilioSms } from './twilio.js';

const sid = 'AC' + 'a'.repeat(32);

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe('twilioSms', () => {
  it('llama a la API de mensajes con autenticación básica y el formulario esperado', async () => {
    const f = fakeFetch(201, { sid: 'SM1' });
    await twilioSms({ accountSid: sid, authToken: 'token', from: '+15005550006', fetch: f }).send(
      '+525512345678',
      'hola',
    );
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from(`${sid}:token`).toString('base64')}`,
    );
    const form = init?.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({ To: '+525512345678', Body: 'hola', From: '+15005550006' });
  });

  it('usa la API key y el Messaging Service cuando se dan', async () => {
    const f = fakeFetch(201);
    const key = 'SK' + 'b'.repeat(32);
    const mg = 'MG' + 'c'.repeat(32);
    await twilioSms({
      accountSid: sid,
      apiKeySid: key,
      authToken: 'secret',
      messagingServiceSid: mg,
      fetch: f,
    }).send('+525512345678', 'hola');
    const init = f.mock.calls[0]![1];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from(`${key}:secret`).toString('base64')}`,
    );
    const form = init?.body as URLSearchParams;
    expect(form.get('MessagingServiceSid')).toBe(mg);
    expect(form.has('From')).toBe(false);
  });

  it('convierte un rechazo de Twilio en SmsSendError con su código, sin el texto', async () => {
    const f = fakeFetch(400, { code: 21211, message: "The 'To' number +52... is not valid" });
    const err = await twilioSms({ accountSid: sid, authToken: 't', from: '+15005550006', fetch: f })
      .send('+525512345678', 'Tempora: tu código es 123456')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect(err).toMatchObject({ status: 400, code: 21211 });
    expect((err as Error).message).not.toMatch(/123456|\+52/);
  });

  it('un fallo de red también es SmsSendError', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      twilioSms({ accountSid: sid, authToken: 't', from: '+15005550006', fetch: f }).send(
        '+525512345678',
        'x',
      ),
    ).rejects.toBeInstanceOf(SmsSendError);
  });

  it('exige remitente o Messaging Service', () => {
    expect(() => twilioSms({ accountSid: sid, authToken: 't' })).toThrow(/from/);
  });
});
