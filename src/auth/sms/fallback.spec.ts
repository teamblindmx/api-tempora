import { describe, expect, it, vi } from 'vitest';
import type { SmsSender } from '../messaging.js';
import { withFallback } from './fallback.js';

const ok = () => ({ send: vi.fn<SmsSender['send']>(async () => {}) });
const failing = (msg: string) => ({
  send: vi.fn<SmsSender['send']>(async () => {
    throw new Error(msg);
  }),
});

describe('withFallback', () => {
  it('si el principal funciona, no toca el respaldo', async () => {
    const whatsapp = ok();
    const sms = ok();
    await withFallback([
      { name: 'whatsapp', sender: whatsapp },
      { name: 'twilio', sender: sms },
    ]).send('+525512345678', 'hola');
    expect(whatsapp.send).toHaveBeenCalledOnce();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('si el principal falla, usa el respaldo y lo registra sin el texto', async () => {
    const sms = ok();
    const log = vi.fn<(msg: string) => void>();
    await withFallback(
      [
        { name: 'whatsapp', sender: failing('sin plantilla') },
        { name: 'twilio', sender: sms },
      ],
      log,
    ).send('+525512345678', 'Tempora: tu código es 123456');
    expect(sms.send).toHaveBeenCalledWith('+525512345678', 'Tempora: tu código es 123456');
    expect(log).toHaveBeenCalledWith('[mensajes] falló whatsapp: sin plantilla; se intenta con twilio');
    expect(String(log.mock.calls)).not.toMatch(/123456/);
  });

  it('si todos fallan, lanza AggregateError con cada error', async () => {
    const err = await withFallback(
      [
        { name: 'a', sender: failing('uno') },
        { name: 'b', sender: failing('dos') },
      ],
      () => {},
    )
      .send('+525512345678', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2);
  });
});
