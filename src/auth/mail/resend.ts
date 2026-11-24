import type { Mailer } from '../messaging.js';
import { type Email, emailText } from './templates.js';

export interface ResendOptions {
  apiKey: string;
  /** Remitente con dominio verificado en Resend: `Tempora <no-responder@tempora.mx>`. */
  from: string;
  /** A dónde llegan las respuestas, si no al remitente. */
  replyTo?: string | undefined;
  /** Para pruebas. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Error de Resend. `name` es el tipo de error de Resend (p. ej. validation_error). Sin el destino. */
export class MailSendError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(`${provider}: no se pudo enviar el correo (HTTP ${status ?? 'sin respuesta'}, ${code ?? '-'})`);
    this.name = 'MailSendError';
  }
}

/**
 * Envía correos con la API de Resend (POST /emails). Sin el SDK: es una sola llamada HTTP, como
 * Twilio (ADR 0017).
 */
export function resendMailer(options: ResendOptions): Mailer {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? 'https://api.resend.com'}/emails`;

  async function send(to: string, email: Email) {
    // Quien entra por teléfono tiene un correo de relleno (@phone.invalid): no existe, no se manda.
    if (to.toLowerCase().endsWith('.invalid')) return;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: options.from,
          to: [to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(options.replyTo ? { reply_to: options.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new MailSendError('resend', undefined, undefined);
    }
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => undefined);
      const code =
        typeof data === 'object' && data !== null && 'name' in data && typeof data.name === 'string'
          ? data.name
          : undefined;
      throw new MailSendError('resend', res.status, code);
    }
  }

  return {
    sendVerificationEmail: (to, link) => send(to, emailText.verification(link)),
    sendInvitationEmail: (to, link) => send(to, emailText.invitation(link)),
  };
}
