import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, withCompany, type BasePrisma } from '../src/database/prisma-client.js';
import { ownerRollback, query, testConfig } from './helpers.js';

const A = 'company-a';
const B = 'company-b';
let db: BasePrisma;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = createPrismaClient(testConfig().DATABASE_URL, 4);
  for (const c of [A, B]) {
    const s = await withCompany(db, c, (tx) =>
      tx.site.create({ data: { companyId: c, id: `sede-${c}`, latitude: 20, longitude: -103 } }),
    );
    ids[c] = s.id;
    await withCompany(db, c, (tx) =>
      tx.auditLog.create({ data: { companyId: c, action: 'test', targetType: 'site', targetId: s.id } }),
    );
  }
});
afterAll(async () => {
  await db?.$disconnect();
});

describe('Roles de la base', () => {
  it('ningún rol de la aplicación es superusuario ni salta RLS', async () => {
    const rows = await query(
      'owner',
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('tempora_app','tempora_auth','tempora_owner')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r, r.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('la API se conecta como tempora_app, que no es dueño de nada en app', async () => {
    const [me] = await db.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
    expect(me!.u).toBe('tempora_app');
    const owned = await query(
      'owner',
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND pg_get_userbyid(c.relowner) = 'tempora_app'`,
    );
    expect(owned).toEqual([]);
  });

  it('tempora_app no puede leer el esquema auth, ni tempora_auth el esquema app', async () => {
    await expect(query('app', 'SELECT * FROM auth."user" LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(query('auth', 'SELECT * FROM app.site LIMIT 1')).rejects.toThrow(/permission denied/);
  });
});

describe('Catálogo: cada tabla de negocio tiene RLS', () => {
  it('toda tabla de app tiene RLS activado y forzado, con al menos una política y company_id', async () => {
    const rows = await query<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: number;
      has_company: boolean;
    }>(
      'owner',
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id') AS has_company
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r, `app.${r.relname}`).toMatchObject({ rls: true, force: true, has_company: true });
      expect(r.policies, `app.${r.relname} sin política`).toBeGreaterThan(0);
    }
  });
});

describe('Aislamiento en la base (rol de la API)', () => {
  it('lectura, listado y conteo: cada compañía ve solo lo suyo', async () => {
    const rows = await withCompany(db, A, (tx) => tx.site.findMany());
    expect(rows.map((r) => r.companyId)).toEqual([A]);
    expect(await withCompany(db, A, (tx) => tx.site.findUnique({ where: { id: ids[B]! } }))).toBeNull();
    expect(await withCompany(db, A, (tx) => tx.site.findMany({ where: { companyId: B } }))).toEqual([]);
    expect(await withCompany(db, A, (tx) => tx.auditLog.count())).toBe(1);
  });

  it('actualización y borrado sobre filas de otra compañía no afectan nada', async () => {
    const u = await withCompany(db, A, (tx) =>
      tx.site.updateMany({ where: { id: ids[B]! }, data: { radiusM: 999 } }),
    );
    expect(u.count).toBe(0);
    const d = await withCompany(db, A, (tx) => tx.site.deleteMany({ where: { id: ids[B]! } }));
    expect(d.count).toBe(0);
    const b = await withCompany(db, B, (tx) => tx.site.findUnique({ where: { id: ids[B]! } }));
    expect(b?.radiusM).toBe(500);
  });

  it('no se puede insertar ni mover filas a otra compañía', async () => {
    await expect(
      withCompany(db, A, (tx) =>
        tx.site.create({ data: { companyId: B, id: randomUUID(), latitude: 0, longitude: 0 } }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withCompany(db, A, (tx) => tx.site.update({ where: { id: ids[A]! }, data: { companyId: B } })),
    ).rejects.toThrow(/row-level security/);
  });

  it('un perfil de A no puede apuntar a una sede de B (FK compuesta)', async () => {
    await expect(
      withCompany(db, A, (tx) =>
        tx.employeeProfile.create({ data: { companyId: A, userId: 'u1', siteId: ids[B]! } }),
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it('sin compañía fijada no se ve ni se escribe nada', async () => {
    expect(await db.site.findMany()).toEqual([]);
    expect(await db.$queryRaw`SELECT * FROM app.site`).toEqual([]);
    await expect(
      db.site.create({ data: { companyId: A, id: randomUUID(), latitude: 0, longitude: 0 } }),
    ).rejects.toThrow(/row-level security/);
  });

  it('el rol dueño también está sujeto a RLS (FORCE); sin FORCE vería todo', async () => {
    expect(await query('owner', 'SELECT * FROM app.site')).toEqual([]);
    // Documenta el salto: en una transacción que se revierte, sin FORCE el dueño ve todo.
    const all = await ownerRollback(async (c) => {
      await c.query('ALTER TABLE app.site NO FORCE ROW LEVEL SECURITY');
      return (await c.query('SELECT company_id FROM app.site')).rows;
    });
    const companies = new Set(all.map((r) => r.company_id));
    expect(companies.has(A) && companies.has(B)).toBe(true);
  });
});

/** Como dueño, con la compañía A fijada, en una transacción que se revierte. */
const asOwnerInA = (sql: string) =>
  ownerRollback(async (c) => {
    await c.query(`SELECT set_config('app.company_id', $1, true)`, [A]);
    return (await c.query(sql)).rows;
  });

describe('Auditoría de solo inserción', () => {
  it('el rol de la API puede insertar y leer, pero no actualizar ni borrar', async () => {
    await expect(
      withCompany(db, A, (tx) => tx.auditLog.updateMany({ data: { reason: 'cambiado' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(withCompany(db, A, (tx) => tx.auditLog.deleteMany({}))).rejects.toThrow(/permission denied/);
  });

  it('ni el dueño puede actualizar, borrar o vaciar la tabla', async () => {
    await expect(asOwnerInA(`UPDATE app.audit_log SET reason = 'x'`)).rejects.toThrow(/solo inserción/);
    await expect(asOwnerInA('DELETE FROM app.audit_log')).rejects.toThrow(/solo inserción/);
    await expect(asOwnerInA('TRUNCATE app.audit_log')).rejects.toThrow(/solo inserción/);
  });

  it('cada registro guarda su compañía (no se puede auditar en otra)', async () => {
    await expect(
      withCompany(db, A, (tx) =>
        tx.auditLog.create({ data: { companyId: B, action: 'x', targetType: 'x' } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('Concurrencia en un solo pool', () => {
  it('200 transacciones intercaladas de A y B con 4 conexiones nunca cruzan datos', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const c = i % 2 ? B : A;
        return withCompany(db, c, async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_sleep(${(Math.random() * 0.005).toFixed(4)})`);
          return tx.site.findMany();
        }).then((rows) => ({ c, rows }));
      }),
    );
    for (const { c, rows } of results) {
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.companyId).toBe(c);
    }
  });

  it('una petición sin compañía no hereda la de la anterior en la misma conexión', async () => {
    const one = createPrismaClient(testConfig().DATABASE_URL, 1);
    try {
      expect(await withCompany(one, A, (tx) => tx.site.count())).toBeGreaterThan(0);
      expect(await one.site.count()).toBe(0);
    } finally {
      await one.$disconnect();
    }
  });

  it('identificadores aleatorios de otra compañía siguen sin verse', async () => {
    expect(await withCompany(db, randomUUID(), (tx) => tx.site.count())).toBe(0);
  });
});

describe('Jornada: códigos y marcajes', () => {
  const now = new Date('2026-12-01T14:00:00Z');
  const codes: Record<string, string> = {};
  const records: Record<string, string> = {};

  beforeAll(async () => {
    for (const c of [A, B]) {
      const code = await withCompany(db, c, (tx) =>
        tx.dailyCode.create({
          data: {
            companyId: c,
            siteId: ids[c]!,
            code: '123456',
            createdBy: 'u',
            createdAt: now,
            expiresAt: new Date(now.getTime() + 30 * 60_000),
          },
        }),
      );
      codes[c] = code.id;
      const r = await withCompany(db, c, (tx) =>
        tx.attendanceRecord.create({
          data: {
            companyId: c,
            siteId: ids[c]!,
            userId: 'u1',
            workDate: new Date('2026-12-01T00:00:00Z'),
            checkInAt: now,
            dailyCodeId: code.id,
          },
        }),
      );
      records[c] = r.id;
    }
  });

  it('cada compañía ve solo sus códigos y jornadas, aunque el código coincida', async () => {
    const found = await withCompany(db, A, (tx) => tx.dailyCode.findMany({ where: { code: '123456' } }));
    expect(found.map((c) => c.id)).toEqual([codes[A]]);
    expect(await withCompany(db, A, (tx) => tx.attendanceRecord.findMany())).toEqual([
      expect.objectContaining({ id: records[A], companyId: A }),
    ]);
    const u = await withCompany(db, A, (tx) =>
      tx.attendanceRecord.updateMany({ where: { id: records[B]! }, data: { checkOutAt: now } }),
    );
    expect(u.count).toBe(0);
  });

  it('una jornada de A no puede usar un código ni una sede de B (FK compuestas)', async () => {
    const base = { companyId: A, userId: 'u2', workDate: new Date('2026-12-02T00:00:00Z'), checkInAt: now };
    await expect(
      withCompany(db, A, (tx) =>
        tx.attendanceRecord.create({ data: { ...base, siteId: ids[A]!, dailyCodeId: codes[B]! } }),
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
    await expect(
      withCompany(db, A, (tx) =>
        tx.attendanceRecord.create({ data: { ...base, siteId: ids[B]!, dailyCodeId: codes[A]! } }),
      ),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it('la API no puede borrar jornadas ni códigos (son la evidencia del registro)', async () => {
    await expect(withCompany(db, A, (tx) => tx.attendanceRecord.deleteMany({}))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withCompany(db, A, (tx) => tx.dailyCode.deleteMany({}))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('una salida anticipada sin motivo no entra a la base', async () => {
    await expect(
      withCompany(db, A, (tx) =>
        tx.attendanceRecord.update({
          where: { id: records[A]! },
          data: { checkOutAt: new Date(now.getTime() + 3600_000), checkOutKind: 'early' },
        }),
      ),
    ).rejects.toThrow(/attendance_early_exit_reason/);
  });
});
