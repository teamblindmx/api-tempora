import { z } from 'zod';

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
  return config;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
