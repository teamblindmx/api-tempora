import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateAuth } from '../src/auth/auth.js';
import { loadConfig } from '../src/config/config.js';

declare module 'vitest' {
  export interface ProvidedContext {
    env: Record<string, string>;
  }
}

function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Las pruebas e2e necesitan ${name} (ver .env.example)`);
  return v;
}

/** Base de datos de prueba aparte: se crea y se elimina en cada ejecución (plan 0001, paso 6). */
export default async function setup(project: TestProject) {
  const ownerUrl = required('DATABASE_URL_OWNER');
  const db = `tempora_test_${Date.now()}_${randomBytes(3).toString('hex')}`;

  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();

  const env = {
    NODE_ENV: 'test',
    DATABASE_URL_OWNER: withDatabase(ownerUrl, db),
    DATABASE_URL: withDatabase(required('DATABASE_URL'), db),
    DATABASE_URL_AUTH: withDatabase(required('DATABASE_URL_AUTH'), db),
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64'),
    BETTER_AUTH_URL: 'http://localhost:3000',
    TRUSTED_ORIGINS: 'http://localhost:5173',
    COOKIE_DOMAIN: '',
    DB_POOL_MAX: '4',
    AUTH_POOL_MAX: '4',
  };

  const owner = new pg.Client({ connectionString: env.DATABASE_URL_OWNER });
  await owner.connect();
  await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; CREATE SCHEMA auth AUTHORIZATION tempora_auth');
  await owner.end();

  // Se llama al CLI de Prisma con node y no con `npx`: en Windows `npx` es `npx.cmd` y
  // execFileSync no puede lanzarlo sin shell (spawnSync npx ENOENT).
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  await migrateAuth(loadConfig(env));

  project.provide('env', env);

  return async () => {
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.end();
  };
}
