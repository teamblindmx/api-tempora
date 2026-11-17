import pg from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { axeda, secureAuthOptions, sessionPrincipal } from '@teamblind/axeda-better-auth';
import type { AppConfig } from '../config/config.js';
import { PERMISSION_CATALOG, ROLES } from './permissions.js';

export interface Mailer {
  sendVerificationEmail(to: string, url: string): Promise<void>;
}

/** Correo de desarrollo: imprime el enlace en la consola. */
export const consoleMailer: Mailer = {
  async sendVerificationEmail(to, url) {
    console.info(`[correo de desarrollo] Verificación para ${to}: ${url}`);
  },
};

/**
 * Configuración de Better Auth + Axeda. Se usa al arrancar y en scripts/migrate-auth.ts.
 * Better Auth y Axeda usan su propio pg.Pool, en el esquema auth (search_path en DATABASE_URL_AUTH).
 */
export function buildAuthOptions(config: AppConfig, mailer: Mailer = consoleMailer) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL_AUTH,
    max: config.AUTH_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const axedaPlugin = axeda({ permissions: [...PERMISSION_CATALOG], roles: ROLES });
  const preset = secureAuthOptions({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.TRUSTED_ORIGINS,
    environment: config.NODE_ENV === 'production' ? 'production' : 'development',
  });
  const options = {
    ...preset,
    // Cookie compartida entre subdominios del mismo dominio (app.tempora.mx y api.tempora.mx).
    // Sigue siendo SameSite=Lax: frontend y API deben estar en el mismo sitio (ADR 0008).
    advanced: config.COOKIE_DOMAIN
      ? { ...preset.advanced, crossSubDomainCookies: { enabled: true, domain: config.COOKIE_DOMAIN } }
      : preset.advanced,
    database: pool,
    plugins: [axedaPlugin],
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        mailer.sendVerificationEmail(user.email, url),
    },
  };
  return { options, pool, axedaPlugin };
}

/** Crea las tablas de Better Auth y Axeda en el esquema auth (idempotente). */
export async function migrateAuth(config: AppConfig) {
  const { options, pool } = buildAuthOptions(config);
  try {
    await (await getMigrations(options)).runMigrations();
  } finally {
    await pool.end();
  }
}

export async function createAuth(config: AppConfig, mailer?: Mailer) {
  const { options, pool, axedaPlugin } = buildAuthOptions(config, mailer);
  const auth = betterAuth(options);
  await auth.$context;
  // Verifica que la base tenga transacciones reales y sincroniza los roles: si falla, no arranca.
  await axedaPlugin.start();
  return {
    auth,
    axeda: axedaPlugin.instance(),
    principal: sessionPrincipal(auth),
    pool,
    async close() {
      await pool.end();
    },
  };
}

export type AuthService = Awaited<ReturnType<typeof createAuth>>;
export const AUTH = Symbol('AUTH');
