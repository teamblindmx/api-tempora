import type { SmsSender } from '../messaging.js';

export interface TwilioOptions {
  accountSid: string;
  /** Auth Token de la cuenta, o el secreto de la API key si se da `apiKeySid`. */
  authToken: string;
  /** API key (SK...). Recomendada en producción: se puede revocar sin tocar el Auth Token. */
  apiKeySid?: string;
  /** Número remitente en E.164. Se usa si no hay `messagingServiceSid`. */
  from?: string;
  /** Messaging Service (MG...). Si se da, Twilio elige el remitente. */
  messagingServiceSid?: string;
  /** Para pruebas. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Error de Twilio. `code` es el código de Twilio (p. ej. 21211, número inválido). Sin el texto ni el destino. */
export class SmsSendError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    readonly code: number | undefined,
  ) {
    super(`${provider}: no se pudo enviar el SMS (HTTP ${status ?? 'sin respuesta'}, código ${code ?? '-'})`);
    this.name = 'SmsSendError';
  }
}

/**
 * Envía SMS con la API de mensajes de Twilio (POST /2010-04-01/Accounts/{sid}/Messages.json).
 * Sin el SDK: es una sola llamada HTTP y así no se agrega una dependencia grande.
 */
export function twilioSms(options: TwilioOptions): SmsSender {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? 'https://api.twilio.com';
  const url = `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const user = options.apiKeySid ?? options.accountSid;
  const authorization = `Basic ${Buffer.from(`${user}:${options.authToken}`).toString('base64')}`;
  if (!options.messagingServiceSid && !options.from) {
    throw new Error('twilioSms: falta `from` o `messagingServiceSid`');
  }

  return {
    async send(to, text) {
      const body = new URLSearchParams({ To: to, Body: text });
      if (options.messagingServiceSid) body.set('MessagingServiceSid', options.messagingServiceSid);
      else body.set('From', options.from!);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        throw new SmsSendError('twilio', undefined, undefined);
      }
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => undefined);
        const code =
          typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'number'
            ? data.code
            : undefined;
        throw new SmsSendError('twilio', res.status, code);
      }
    },
  };
}
