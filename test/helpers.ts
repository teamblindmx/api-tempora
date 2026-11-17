import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Actor, Company } from '@teamblind/axeda-core';
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
  outbox: Map<string, string>;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const outbox = new Map<string, string>();
  const { app, auth, openapi } = await createApp(testConfig(), {
    mailer: {
      async sendVerificationEmail(to, url) {
        outbox.set(to, url);
      },
    },
  });
  return {
    app,
    server: app.getHttpServer(),
    auth,
    openapi: openapi as never,
    outbox,
    close: () => app.close(),
  };
}

export interface TestUser {
  email: string;
  userId: string;
  cookie: string;
  actor: Actor;
}

/** Registro, verificación de correo e inicio de sesión, por HTTP como lo haría el frontend. */
export async function createUser(t: TestApp, name: string): Promise<TestUser> {
  // Better Auth guarda el correo en minúsculas.
  const email = `${name}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`.toLowerCase();
  const password = 'contraseña-de-prueba-123';
  const up = await request(t.server)
    .post('/api/auth/sign-up/email')
    .set('Origin', FRONTEND)
    .send({ email, password, name });
  if (up.status !== 200) throw new Error(`sign-up ${up.status}: ${up.text}`);
  // Better Auth puede enviar el correo en segundo plano: se espera hasta 2 s.
  let link = t.outbox.get(email);
  for (let i = 0; !link && i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    link = t.outbox.get(email);
  }
  if (!link) throw new Error('No llegó el correo de verificación');
  const u = new URL(link);
  await request(t.server).get(u.pathname + u.search);
  const res = await request(t.server)
    .post('/api/auth/sign-in/email')
    .set('Origin', FRONTEND)
    .send({ email, password });
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${res.text}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const userId = res.body.user.id as string;
  return { email, userId, cookie, actor: { userId } };
}

export interface Tenants {
  owner: TestUser;
  companyA: Company;
  companyB: Company;
  adminA: TestUser;
  adminB: TestUser;
  workerA: TestUser;
}

/** Dueño de la plataforma, dos compañías y sus usuarios, creados con Axeda como lo haría el gestor. */
export async function createTenants(t: TestApp): Promise<Tenants> {
  const { axeda } = t.auth;
  const owner = await createUser(t, 'owner');
  await axeda.bootstrap({ userId: owner.userId });

  const suffix = Math.random().toString(36).slice(2, 8);
  const companyA = await axeda.companies.create(owner.actor, {
    slug: `acme-${suffix}`,
    name: 'Acme Industrial',
  });
  const companyB = await axeda.companies.create(owner.actor, {
    slug: `beta-${suffix}`,
    name: 'Beta Manufacturas',
  });

  const roles = (await axeda.roles.list(owner.actor, { limit: 100 })).items;
  const roleId = (key: RoleKey) => {
    const r = roles.find((x) => x.key === key);
    if (!r) throw new Error(`Rol ${key} no sincronizado`);
    return r.id;
  };
  const assign = (u: TestUser, key: RoleKey, companyId: string) =>
    axeda.assignments.assign(owner.actor, {
      userId: u.userId,
      roleId: roleId(key),
      scope: { type: 'company', id: companyId },
    });

  const adminA = await createUser(t, 'adminA');
  const adminB = await createUser(t, 'adminB');
  const workerA = await createUser(t, 'workerA');
  await assign(adminA, 'company-admin', companyA.id);
  await assign(adminB, 'company-admin', companyB.id);
  await assign(workerA, 'worker', companyA.id);
  return { owner, companyA, companyB, adminA, adminB, workerA };
}

/** Peticiones con la sesión de un usuario, desde el frontend de confianza. */
export function as(t: TestApp, user: TestUser) {
  const withAuth = (r: request.Test) => r.set('Cookie', user.cookie).set('Origin', FRONTEND);
  return {
    get: (path: string) => withAuth(request(t.server).get(path)),
    post: (path: string, body?: object) => withAuth(request(t.server).post(path)).send(body ?? {}),
  };
}
