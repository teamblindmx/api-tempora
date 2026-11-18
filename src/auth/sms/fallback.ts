import type { SmsSender } from '../messaging.js';

export interface NamedSender {
  name: string;
  sender: SmsSender;
}

/**
 * Prueba los canales en orden y se queda con el primero que funcione.
 * Pensado para WhatsApp (Meta) como principal y Twilio SMS como respaldo.
 * Los registros llevan el canal y el error, nunca el texto (puede traer un código de acceso).
 */
export function withFallback(
  channels: NamedSender[],
  log: (msg: string) => void = (msg) => console.warn(msg),
): SmsSender {
  if (channels.length === 0) throw new Error('withFallback: hace falta al menos un canal');
  return {
    async send(to, text) {
      const errors: unknown[] = [];
      for (const [i, { name, sender }] of channels.entries()) {
        try {
          await sender.send(to, text);
          return;
        } catch (err) {
          errors.push(err);
          const next = channels[i + 1];
          log(
            `[mensajes] falló ${name}: ${err instanceof Error ? err.message : String(err)}` +
              (next ? `; se intenta con ${next.name}` : ''),
          );
        }
      }
      throw new AggregateError(errors, 'No se pudo enviar el mensaje por ningún canal');
    },
  };
}
