import type { AppConfig } from '../../config/config.js';
import { consoleSms, type SmsSender } from '../messaging.js';
import { withFallback } from './fallback.js';
import { twilioSms } from './twilio.js';

/**
 * Elige el envío de SMS según SMS_PROVIDER. Cuando llegue WhatsApp (Meta), va primero en la lista
 * y Twilio queda de respaldo, para usarlo lo menos posible.
 */
export function smsFromConfig(config: AppConfig): SmsSender {
  if (config.SMS_PROVIDER === 'console') return consoleSms;
  return withFallback([
    {
      name: 'twilio',
      sender: twilioSms({
        accountSid: config.TWILIO_ACCOUNT_SID!,
        authToken: config.TWILIO_AUTH_TOKEN!,
        apiKeySid: config.TWILIO_API_KEY_SID,
        from: config.TWILIO_FROM,
        messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
      }),
    },
  ]);
}
