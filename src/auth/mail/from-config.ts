import type { AppConfig } from '../../config/config.js';
import { consoleMailer, type Mailer } from '../messaging.js';
import { resendMailer } from './resend.js';

/** Elige el envío de correos según MAIL_PROVIDER: la consola en desarrollo, Resend en producción. */
export function mailerFromConfig(config: AppConfig): Mailer {
  if (config.MAIL_PROVIDER === 'console') return consoleMailer;
  return resendMailer({
    apiKey: config.RESEND_API_KEY!,
    from: config.MAIL_FROM!,
    replyTo: config.MAIL_REPLY_TO,
  });
}
