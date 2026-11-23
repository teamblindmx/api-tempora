import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Actor, AssignmentScope, Company, Site } from '@teamblind/axeda-core';
import pg from 'pg';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.factory.js';
import type { AuthService } from '../src/auth/auth.js';
import type { RoleKey } from '../src/auth/permissions.js';
import { type AppConfig, loadConfig } from '../src/config/config.js';

export const FRONTEND = 'http://localhost:5173';

export function testConfig(): AppConfig {
  return loadConfig(inject('env'));
}

/** Consulta directa con un rol de la base (para revisar el catálogo y los permisos). */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  role: 'owner' | 'app' | 'auth',
  sql: string,
  params: unknown[] = [],
) {
  const env = inject('env');
  const url = { owner: env['DATABASE_URL_OWNER'], app: env['DATABASE_URL'], auth: env['DATABASE_URL_AUTH'] }[
    role
  ];
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** Corre algo como dueño dentro de una transacción que siempre se revierte. */
export async function ownerRollback<T>(fn: (c: pg.Client) => Promise<T[]>): Promise<T[]> {
  const c = new pg.Client({ connectionString: inject('env')['DATABASE_URL_OWNER'] });
  await c.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

export interface TestApp {
  app: NestExpressApplication;
  server: ReturnType<NestExpressApplication['getHttpServer']>;
  auth: AuthService;
  openapi: Record<string, unknown>;
  /** Último correo (verificación o invitación) por destinatario: el enlace. */
  outbox: Map<string, string>;
  /** Último SMS por número. */
  sms: Map<string, string>;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const outbox = new Map<string, string>();
  const sms = new Map<string, string>();
  const { app, auth, openapi } = await createApp(testConfig(), {
    mailer: {
      async sendVerificationEmail(to, url) {
        outbox.set(to, url);
      },
      async sendInvitationEmail(to, url) {
        outbox.set(to, url);
      },
    },
    sms: {
      async send(to, text) {
        sms.set(to, text);
      },
    },
  });
  return {
    app,
    server: app.getHttpServer(),
    auth,
    openapi: openapi as never,
    outbox,
    sms,
    close: () => app.close(),
  };
}

/** Espera hasta 2 s a que llegue un mensaje (Better Auth y Axeda pueden enviarlo en segundo plano). */
export async function waitFor(box: Map<string, string>, key: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const v = box.get(key);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`No llegó el mensaje para ${key}`);
}

export interface TestUser {
  email: string;
  userId: string;
  cookie: string;
  /** Las cabeceras Set-Cookie del inicio de sesión, tal como llegaron. */
  setCookie: string[];
  actor: Actor;
}

const cookieOf = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

/**
 * Registro, verificación de correo e inicio de sesión, por HTTP como lo haría el frontend. Better Auth
 * limita registros e inicios de sesión por IP (5 cada tanto): un archivo que necesita más usuarios
 * que los de createTenants les pone otra IP con `ip`.
 */
export async function createUser(t: TestApp, name: string, opts: { ip?: string } = {}): Promise<TestUser> {
  const fromIp = (r: request.Test) => (opts.ip ? r.set('X-Forwarded-For', opts.ip) : r);
  // Better Auth guarda el correo en minúsculas.
  const email = `${name}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`.toLowerCase();
  const password = 'contraseña-de-prueba-123';
  t.outbox.delete(email);
  const up = await fromIp(request(t.server).post('/api/auth/sign-up/email'))
    .set('Origin', FRONTEND)
    .send({ email, password, name });
  if (up.status !== 200) throw new Error(`sign-up ${up.status}: ${up.text}`);
  const u = new URL(await waitFor(t.outbox, email));
  await request(t.server).get(u.pathname + u.search);
  const res = await fromIp(request(t.server).post('/api/auth/sign-in/email'))
    .set('Origin', FRONTEND)
    .send({ email, password });
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${res.text}`);
  const userId = res.body.user.id as string;
  return {
    email,
    userId,
    cookie: cookieOf(res),
    setCookie: res.headers['set-cookie'] as unknown as string[],
    actor: { userId },
  };
}

/** Registro o inicio de sesión por teléfono (código por SMS). */
export async function signInByPhone(t: TestApp, phoneNumber: string): Promise<TestUser> {
  t.sms.delete(phoneNumber);
  const sent = await request(t.server)
    .post('/api/auth/phone-number/send-otp')
    .set('Origin', FRONTEND)
    .send({ phoneNumber });
  if (sent.status !== 200) throw new Error(`send-otp ${sent.status}: ${sent.text}`);
  const code = /(\d{6})/.exec(await waitFor(t.sms, phoneNumber))?.[1];
  const res = await request(t.server)
    .post('/api/auth/phone-number/verify')
    .set('Origin', FRONTEND)
    .send({ phoneNumber, code });
  if (res.status !== 200) throw new Error(`verify ${res.status}: ${res.text}`);
  const userId = res.body.user.id as string;
  return {
    email: res.body.user.email as string,
    userId,
    cookie: cookieOf(res),
    setCookie: res.headers['set-cookie'] as unknown as string[],
    actor: { userId },
  };
}

export interface Tenants {
  owner: TestUser;
  companyA: Company;
  companyB: Company;
  /** Sedes de Axeda: dos en A, una en B. */
  siteA1: Site;
  siteA2: Site;
  siteB1: Site;
  adminA: TestUser;
  adminB: TestUser;
  /** Líder de la sede A1. */
  leaderA1: TestUser;
  /** Trabajador de la sede A1. */
  workerA1: TestUser;
  roleId(key: RoleKey): string;
}

/**
 * Hace dueño de la plataforma a `owner`. La base de pruebas es una para todos los archivos y Axeda
 * solo admite un bootstrap: del segundo archivo en adelante, el primer dueño le otorga el rol.
 */
async function bootstrapOwner(t: TestApp, owner: TestUser) {
  const [first] = await query<{ userId: string; roleId: string }>(
    'auth',
    `SELECT a."userId", a."roleId" FROM auth."axedaAssignment" a JOIN auth."axedaRole" r ON r.id = a."roleId"
      WHERE r.key = 'super-admin' AND a."scopeType" = 'global' ORDER BY a."createdAt" LIMIT 1`,
  );
  if (!first) {
    await t.auth.axeda.bootstrap({ userId: owner.userId });
    return;
  }
  await t.auth.axeda.assignments.assign(
    { userId: first.userId },
    { userId: owner.userId, roleId: first.roleId, scope: { type: 'global' } },
  );
}

/** Dueño de la plataforma, dos compañías con sedes y sus usuarios, creados con Axeda como lo haría el gestor. */
export async function createTenants(t: TestApp): Promise<Tenants> {
  const { axeda } = t.auth;
  const owner = await createUser(t, 'owner');
  await bootstrapOwner(t, owner);

  const suffix = Math.random().toString(36).slice(2, 8);
  const companyA = await axeda.companies.create(owner.actor, {
    slug: `acme-${suffix}`,
    name: 'Acme Industrial',
  });
  const companyB = await axeda.companies.create(owner.actor, {
    slug: `beta-${suffix}`,
    name: 'Beta Manufacturas',
  });
  const siteA1 = await axeda.sites.create(owner.actor, companyA.id, { slug: 'gdl', name: 'Guadalajara' });
  const siteA2 = await axeda.sites.create(owner.actor, companyA.id, { slug: 'mty', name: 'Monterrey' });
  const siteB1 = await axeda.sites.create(owner.actor, companyB.id, { slug: 'son', name: 'Sonora' });

  const roles = (await axeda.roles.list(owner.actor, { limit: 100 })).items;
  const roleId = (key: RoleKey) => {
    const r = roles.find((x) => x.key === key);
    if (!r) throw new Error(`Rol ${key} no sincronizado`);
    return r.id;
  };
  const assign = (u: TestUser, key: RoleKey, scope: AssignmentScope) =>
    axeda.assignments.assign(owner.actor, { userId: u.userId, roleId: roleId(key), scope });

  const adminA = await createUser(t, 'adminA');
  const adminB = await createUser(t, 'adminB');
  const leaderA1 = await createUser(t, 'leaderA1');
  const workerA1 = await createUser(t, 'workerA1');
  await assign(adminA, 'company-admin', { type: 'company', id: companyA.id });
  await assign(adminB, 'company-admin', { type: 'company', id: companyB.id });
  await assign(leaderA1, 'leader', { type: 'site', id: siteA1.id });
  await assign(workerA1, 'worker', { type: 'site', id: siteA1.id });
  return { owner, companyA, companyB, siteA1, siteA2, siteB1, adminA, adminB, leaderA1, workerA1, roleId };
}

/** Peticiones con la sesión de un usuario, desde el frontend de confianza. */
export function as(t: TestApp, user: TestUser) {
  const withAuth = (r: request.Test) => r.set('Cookie', user.cookie).set('Origin', FRONTEND);
  return {
    get: (path: string) => withAuth(request(t.server).get(path)),
    post: (path: string, body?: object) => withAuth(request(t.server).post(path)).send(body ?? {}),
    put: (path: string, body?: object) => withAuth(request(t.server).put(path)).send(body ?? {}),
  };
}

/** Versión del aviso de privacidad en las pruebas (la de .env.example). */
export const PRIVACY_VERSION = '2026-11-borrador';

/** Acepta el aviso de privacidad vigente desde una sede (es por compañía). Sin esto no se marca. */
export async function acceptPrivacy(t: TestApp, siteId: string, ...users: TestUser[]) {
  for (const u of users) {
    const res = await as(t, u).post(`/sites/${siteId}/privacy-notice/accept`, { version: PRIVACY_VERSION });
    if (res.status !== 200) throw new Error(`privacy-notice/accept ${res.status}: ${res.text}`);
  }
}
