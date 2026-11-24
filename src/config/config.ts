import { z } from 'zod';
import { parseTrustProxy } from '../common/client-ip.js';

const url = z.url({ protocol: /^postgres(ql)?$/ });

/** Lista separada por comas, sin vacíos. */
const csv = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

/** Variable opcional: vacía cuenta como ausente. */
const optional = (schema: z.ZodString) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(schema.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Sin valores por omisión para secretos ni URL: si faltan, la API no arranca.
  DATABASE_URL: url,
  DATABASE_URL_AUTH: url,
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET necesita al menos 32 caracteres'),
  BETTER_AUTH_URL: z.url(),
  TRUSTED_ORIGINS: csv,
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** URL del frontend, para los enlaces de las invitaciones. Por omisión, el primer TRUSTED_ORIGINS. */
  APP_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.url().optional()),
  /** Proveedor de SMS. "console" imprime el mensaje (solo desarrollo); "twilio" lo envía. */
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: optional(z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'debe ser AC seguido de 32 hex')),
  /** Auth Token de la cuenta, o el secreto de la API key si se da TWILIO_API_KEY_SID. */
  TWILIO_AUTH_TOKEN: optional(z.string().min(16)),
  TWILIO_API_KEY_SID: optional(z.string().regex(/^SK[0-9a-fA-F]{32}$/, 'debe ser SK seguido de 32 hex')),
  /** Remitente en E.164, o bien un Messaging Service. */
  TWILIO_FROM: optional(z.string().regex(/^\+[1-9]\d{6,14}$/, 'debe estar en formato E.164')),
  TWILIO_MESSAGING_SERVICE_SID: optional(
    z.string().regex(/^MG[0-9a-fA-F]{32}$/, 'debe ser MG seguido de 32 hex'),
  ),
  /** Proveedor de correo. "console" imprime el correo (solo desarrollo); "resend" lo envía (ADR 0017). */
  MAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: optional(z.string().regex(/^re_[A-Za-z0-9_]{8,}$/, 'debe empezar con re_')),
  /** Remitente con un dominio verificado en Resend: "Tempora <no-responder@tempora.mx>" o solo el correo. */
  MAIL_FROM: optional(
    z
      .string()
      .regex(
        /^(?:[^<>@"]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/,
        'un correo, o "Nombre <correo>"',
      ),
  ),
  /** A dónde llegan las respuestas (opcional). */
  MAIL_REPLY_TO: optional(z.string().regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, 'un correo')),
  /**
   * Versión vigente del aviso de privacidad (el texto vive en el frontend). Al cambiarla, todos deben
   * aceptarlo de nuevo antes de marcar (ADR 0014). Súbela cuando el abogado revise el texto.
   */
  PRIVACY_NOTICE_VERSION: z
    .string()
    .trim()
    .regex(/^[\w.-]{1,40}$/, 'letras, números, punto o guion, hasta 40')
    .default('2026-11-borrador'),
  /**
   * Proxies delante de la API (ADR 0016): vacío = ninguno; un número = cuántos saltos (en una
   * plataforma con balanceador, normalmente 1); o IPs/rangos CIDR. De aquí sale la IP del cliente
   * para los topes de intentos y la auditoría.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const parsed = parseTrustProxy(v);
      if (parsed === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'vacío, "false", "true", un número de 1 a 10, o IPs/rangos CIDR separados por coma',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  AUTH_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

/** Lee y valida la configuración. Lanza ConfigError con todas las variables que fallan. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`);
    throw new ConfigError(`Configuración inválida:\n${lines.join('\n')}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && !config.BETTER_AUTH_URL.startsWith('https://')) {
    throw new ConfigError('Configuración inválida:\n  - BETTER_AUTH_URL: en producción debe usar https');
  }
  if (config.NODE_ENV === 'production' && config.SMS_PROVIDER === 'console') {
    throw new ConfigError(
      'Configuración inválida:\n  - SMS_PROVIDER: "console" no envía mensajes; en producción hace falta un proveedor real',
    );
  }
  if (config.NODE_ENV === 'production' && config.MAIL_PROVIDER === 'console') {
    throw new ConfigError(
      'Configuración inválida:\n  - MAIL_PROVIDER: "console" no envía correos; en producción hace falta "resend"',
    );
  }
  if (config.MAIL_PROVIDER === 'resend') {
    const missing = [!config.RESEND_API_KEY && 'RESEND_API_KEY', !config.MAIL_FROM && 'MAIL_FROM'].filter(
      Boolean,
    );
    if (missing.length > 0) {
      throw new ConfigError(
        `Configuración inválida:\n${missing.map((m) => `  - ${m}: hace falta con MAIL_PROVIDER=resend`).join('\n')}`,
      );
    }
  }
  if (config.SMS_PROVIDER === 'twilio') {
    const missing = [
      !config.TWILIO_ACCOUNT_SID && 'TWILIO_ACCOUNT_SID',
      !config.TWILIO_AUTH_TOKEN && 'TWILIO_AUTH_TOKEN',
      !config.TWILIO_FROM &&
        !config.TWILIO_MESSAGING_SERVICE_SID &&
        'TWILIO_FROM o TWILIO_MESSAGING_SERVICE_SID',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ConfigError(
        `Configuración inválida:\n${missing.map((m) => `  - ${m}: hace falta con SMS_PROVIDER=twilio`).join('\n')}`,
      );
    }
  }
  return config;
}

/** URL base del frontend. */
export function appUrl(config: AppConfig): string {
  return config.APP_URL ?? config.TRUSTED_ORIGINS[0]!;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
