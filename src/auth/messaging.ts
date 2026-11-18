/**
 * Envío de correos y SMS. Axeda y Better Auth no envían nada: la aplicación aporta estos canales.
 * En desarrollo se imprimen en la consola. Para producción hay que conectar un proveedor real
 * (pregunta abierta del PRD: proveedor de SMS y costo).
 */
export interface Mailer {
  sendVerificationEmail(to: string, url: string): Promise<void>;
  sendInvitationEmail(to: string, url: string): Promise<void>;
}

export interface SmsSender {
  /** `to` en formato E.164. El texto no debe llevar datos personales. */
  send(to: string, text: string): Promise<void>;
}

export const consoleMailer: Mailer = {
  async sendVerificationEmail(to, url) {
    console.info(`[correo de desarrollo] Verificación para ${to}: ${url}`);
  },
  async sendInvitationEmail(to, url) {
    console.info(`[correo de desarrollo] Invitación para ${to}: ${url}`);
  },
};

export const consoleSms: SmsSender = {
  async send(to, text) {
    console.info(`[SMS de desarrollo] ${to}: ${text}`);
  },
};

export const smsText = {
  otp: (code: string) => `Tempora: tu código es ${code}. Vence en 5 minutos. No lo compartas.`,
  invitation: (url: string) => `Tempora: te invitaron a registrar tu jornada. Entra aquí: ${url}`,
};
