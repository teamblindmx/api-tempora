import pg from 'pg';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { phoneNumber } from 'better-auth/plugins';
import {
  axeda,
  secureAuthOptions,
  securePhoneNumberOptions,
  sessionPrincipal,
} from '@teamblind/axeda-better-auth';
import type { Axeda, AssignmentScope } from '@teamblind/axeda-core';
import { type AppConfig, appUrl } from '../config/config.js';
import { canGrant, grantorLevel } from './grant-policy.js';
import { consoleMailer, consoleSms, type Mailer, type SmsSender, smsText } from './messaging.js';
import { PERMISSION_CATALOG, ROLES } from './permissions.js';

export type { Mailer, SmsSender } from './messaging.js';

export interface Messaging {
  mailer?: Mailer;
  sms?: SmsSender;
}

/** Rutas de Axeda que otorgan o quitan roles: pasan antes por GRANT_POLICY. */
const GRANT_ROUTES = {
  '/axeda/assignment/create': 'axeda:assignment:manage',
  '/axeda/assignment/revoke': 'axeda:assignment:manage',
  '/axeda/invitation/create': 'axeda:invitation:manage',
} as const;
const isGrantRoute = (path: string): path is keyof typeof GRANT_ROUTES => Object.hasOwn(GRANT_ROUTES, path);

/**
 * Configuración de Better Auth + Axeda. Se usa al arrancar y en scripts/migrate-auth.ts.
 * Better Auth y Axeda usan su propio pg.Pool, en el esquema auth (search_path en DATABASE_URL_AUTH).
 */
export function buildAuthOptions(config: AppConfig, messaging: Messaging = {}) {
  const mailer = messaging.mailer ?? consoleMailer;
  const sms = messaging.sms ?? consoleSms;
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL_AUTH,
    max: config.AUTH_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const axedaPlugin = axeda({
    permissions: [...PERMISSION_CATALOG],
    roles: ROLES,
    invitationDelivery: {
      // La URL base sale de la configuración, nunca de la cabecera Host.
      acceptUrl: (token) => `${appUrl(config)}/invitacion?token=${encodeURIComponent(token)}`,
      send: (m) =>
        m.channel === 'phone' && m.phoneNumber
          ? sms.send(m.phoneNumber, smsText.invitation(m.link))
          : mailer.sendInvitationEmail(m.email, m.link),
    },
  });
  const preset = secureAuthOptions({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.TRUSTED_ORIGINS,
    environment: config.NODE_ENV === 'production' ? 'production' : 'development',
  });

  const instance = (): Axeda => axedaPlugin.instance();
  const options = {
    ...preset,
    // Cookie compartida entre subdominios del mismo dominio (app.tempora.mx y api.tempora.mx).
    // Sigue siendo SameSite=Lax: frontend y API deben estar en el mismo sitio (ADR 0008).
    advanced: config.COOKIE_DOMAIN
      ? { ...preset.advanced, crossSubDomainCookies: { enabled: true, domain: config.COOKIE_DOMAIN } }
      : preset.advanced,
    database: pool,
    plugins: [
      axedaPlugin,
      // Acceso por teléfono (código por SMS). Registro e inicio de sesión en un paso.
      phoneNumber(
        securePhoneNumberOptions({ sendOTP: ({ phoneNumber: to, code }) => sms.send(to, smsText.otp(code)) }),
      ),
    ],
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        mailer.sendVerificationEmail(user.email, url),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!isGrantRoute(ctx.path)) return;
        const permission = GRANT_ROUTES[ctx.path];
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // Axeda responde 401.
        const grant = await describeGrant(pool, ctx.path, ctx.body);
        if (!grant) return; // Cuerpo inválido o asignación inexistente: Axeda responde.
        const ax = instance();
        const target = await ax.resolveTarget(grant.scope);
        if (!target) return; // Axeda responde que no existe.
        const scopes = await ax.scopesFor({ userId: session.user.id }, permission);
        if (!canGrant(grantorLevel(scopes, target), grant.roleKeys)) {
          throw new APIError('FORBIDDEN', {
            code: 'TEMPORA_GRANT_FORBIDDEN',
            message: 'No puedes otorgar ni quitar ese rol en este lugar.',
          });
        }
      }),
    },
  };
  return { options, pool, axedaPlugin };
}

function toScope(type: string, id: string): AssignmentScope | null {
  if (type === 'global') return { type: 'global' };
  if (type === 'company' || type === 'business' || type === 'site') return { type, id };
  return null;
}

/** Qué roles y en qué lugar otorga o quita una petición de Axeda. Lee la base, no confía en el cliente para la revocación. */
async function describeGrant(
  pool: pg.Pool,
  path: string,
  body: unknown,
): Promise<{ scope: AssignmentScope; roleKeys: string[] } | null> {
  const b = (body ?? {}) as { scope?: AssignmentScope; roleId?: unknown; roleIds?: unknown; id?: unknown };
  if (path === '/axeda/assignment/revoke') {
    if (typeof b.id !== 'string') return null;
    const { rows } = await pool.query<{ scopeType: string; scopeId: string; key: string }>(
      `SELECT a."scopeType", a."scopeId", r.key FROM "axedaAssignment" a JOIN "axedaRole" r ON r.id = a."roleId" WHERE a.id = $1`,
      [b.id],
    );
    const row = rows[0];
    if (!row) return null;
    const scope = toScope(row.scopeType, row.scopeId);
    if (!scope) return null;
    return { scope, roleKeys: [row.key] };
  }
  const roleIds = path === '/axeda/assignment/create' ? [b.roleId] : b.roleIds;
  if (!b.scope || !Array.isArray(roleIds) || !roleIds.every((r) => typeof r === 'string')) return null;
  const { rows } = await pool.query<{ id: string; key: string }>(
    `SELECT id, key FROM "axedaRole" WHERE id = ANY($1)`,
    [roleIds],
  );
  // Un rol que no existe se deja a Axeda (responde que no existe).
  if (rows.length !== new Set(roleIds).size) return null;
  return { scope: b.scope, roleKeys: rows.map((r) => r.key) };
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

export async function createAuth(config: AppConfig, messaging?: Messaging) {
  const { options, pool, axedaPlugin } = buildAuthOptions(config, messaging);
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
