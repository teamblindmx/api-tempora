import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTenants, FRONTEND, startApp, type Tenants, type TestApp } from './helpers.js';

let t: TestApp;
let x: Tenants;
const site = (name: string) => ({ name, latitude: 20.676667, longitude: -103.347222 });

beforeAll(async () => {
  t = await startApp();
  x = await createTenants(t);
});
afterAll(async () => {
  await t?.close();
});

describe('Arranque y rutas', () => {
  it('/health es público', async () => {
    await request(t.server).get('/health').expect(200, { status: 'ok' });
  });

  it('una ruta desconocida da 404 sin detalles internos', async () => {
    const r = await request(t.server).get('/no-existe');
    expect(r.status).toBe(404);
    expect(r.text).not.toMatch(/stack|at .*\.ts/);
  });

  it('OpenAPI se genera desde los esquemas Zod', () => {
    const doc = t.openapi as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, any> };
    };
    expect(doc.paths['/companies/{companyId}/sites']?.['post']).toBeDefined();
    const create = Object.entries(doc.components.schemas).find(([k]) => k.startsWith('CreateSite'))?.[1];
    expect(create?.properties?.latitude).toMatchObject({ type: 'number', minimum: -90, maximum: 90 });
  });

  it('Better Auth y Axeda responden en /api/auth', async () => {
    await as(t, x.adminA).get('/api/auth/axeda/me').expect(200);
  });
});

describe('Autenticación', () => {
  it('sin sesión: 401', async () => {
    await request(t.server).get(`/companies/${x.companyA.id}/sites`).expect(401);
  });

  it('CSRF: escritura con cookie desde un origen ajeno da 403', async () => {
    await request(t.server)
      .post(`/companies/${x.companyA.id}/sites`)
      .set('Cookie', x.adminA.cookie)
      .set('Origin', 'https://malo.example.com')
      .send(site('X'))
      .expect(403);
  });

  it('la cookie de sesión es HttpOnly y SameSite=Lax', async () => {
    const r = await request(t.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', FRONTEND)
      .send({ email: x.adminA.email, password: 'contraseña-de-prueba-123' });
    const c = (r.headers['set-cookie'] as unknown as string[]).find((h) => h.includes('session_token'))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });
});

describe('Permisos y aislamiento entre compañías', () => {
  let siteA: { id: string };
  let siteB: { id: string };

  beforeAll(async () => {
    siteA = (await as(t, x.adminA).post(`/companies/${x.companyA.id}/sites`, site('Guadalajara')).expect(201))
      .body;
    siteB = (await as(t, x.adminB).post(`/companies/${x.companyB.id}/sites`, site('Monterrey')).expect(201))
      .body;
  });

  it('el administrador de A ve solo las sedes de A', async () => {
    const r = await as(t, x.adminA).get(`/companies/${x.companyA.id}/sites`).expect(200);
    expect(r.body.map((s: { id: string }) => s.id)).toEqual([siteA.id]);
    expect(r.body[0]).toMatchObject({ companyId: x.companyA.id, radiusM: 500, latitude: 20.676667 });
  });

  it('el administrador de A recibe 403 sobre la compañía B (lectura y escritura)', async () => {
    await as(t, x.adminA).get(`/companies/${x.companyB.id}/sites`).expect(403);
    await as(t, x.adminA).post(`/companies/${x.companyB.id}/sites`, site('Intrusa')).expect(403);
    await as(t, x.adminA).get(`/companies/${x.companyB.id}/audit`).expect(403);
  });

  it('una sede de B pedida por la ruta de A no existe (404)', async () => {
    await as(t, x.adminA).get(`/companies/${x.companyA.id}/sites/${siteB.id}`).expect(404);
  });

  it('una compañía que no existe da el mismo 403 (no revela nada)', async () => {
    await as(t, x.adminA).get('/companies/no-existe/sites').expect(403);
  });

  it('el trabajador no administra sedes ni ve empleados', async () => {
    await as(t, x.workerA).get(`/companies/${x.companyA.id}/sites`).expect(403);
    await as(t, x.workerA).get(`/companies/${x.companyA.id}/employees`).expect(403);
  });

  it('el dueño de la plataforma no ve datos de nómina de los clientes', async () => {
    await as(t, x.owner).get(`/companies/${x.companyA.id}/employees`).expect(403);
    await as(t, x.owner).get(`/companies/${x.companyA.id}/audit`).expect(403);
  });

  it('el cuerpo inválido da 400', async () => {
    await as(t, x.adminA).post(`/companies/${x.companyA.id}/sites`, { name: '', latitude: 200 }).expect(400);
  });

  it('crear una sede deja auditoría en su compañía y no en la otra', async () => {
    const a = await as(t, x.adminA).get(`/companies/${x.companyA.id}/audit`).expect(200);
    expect(a.body).toEqual([
      expect.objectContaining({ action: 'site.create', targetId: siteA.id, actorUserId: x.adminA.userId }),
    ]);
    const b = await as(t, x.adminB).get(`/companies/${x.companyB.id}/audit`).expect(200);
    expect(b.body.map((e: { targetId: string }) => e.targetId)).toEqual([siteB.id]);
  });

  it('50 peticiones concurrentes de A y B nunca cruzan datos', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const [user, company] = i % 2 ? [x.adminB, x.companyB] : [x.adminA, x.companyA];
        return as(t, user)
          .get(`/companies/${company.id}/sites`)
          .then((r) => ({ company: company.id, r }));
      }),
    );
    for (const { company, r } of results) {
      expect(r.status).toBe(200);
      for (const s of r.body) expect(s.companyId).toBe(company);
    }
  });
});
