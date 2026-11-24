import type { INestApplicationContext } from '@nestjs/common';
import { type AssignmentScope, type Invitation, isAxedaError } from '@teamblind/axeda-core';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import type { AuthService } from '../auth/auth.js';
import type { RoleKey } from '../auth/permissions.js';
import { HolidaysService } from '../modules/attendance/holidays.service.js';
import { SitesRepository } from '../modules/sites/sites.repository.js';
import { SiteSettingsSchema } from '../modules/sites/sites.schemas.js';
import type { RequestContext } from '../tenancy/request-context.js';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'minúsculas, números y guiones (p. ej. planta-gdl)')
  .max(60);
const named = z.object({ slug, name: z.string().trim().min(1).max(120) });

/** Roles que se dan desde este comando. El encargado lo da el líder desde la app (después del 1 de enero). */
const PILOT_ROLES = ['company-admin', 'business-admin', 'leader', 'worker'] as const satisfies RoleKey[];
type PilotRole = (typeof PILOT_ROLES)[number];

const PersonSchema = z
  .object({
    email: z
      .email()
      .transform((e) => e.toLowerCase())
      .optional(),
    /** E.164, p. ej. +5213312345678. */
    phoneNumber: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'formato E.164, p. ej. +5213312345678')
      .optional(),
    role: z.enum(PILOT_ROLES),
  })
  .refine((p) => (p.email === undefined) !== (p.phoneNumber === undefined), {
    message: 'cada persona lleva email o phoneNumber, uno solo',
  });

/** El archivo piloto.json (ver docs/runbooks/piloto.example.json). */
export const PilotSchema = z
  .object({
    /** Correo del dueño de la plataforma (npm run bootstrap:admin). Todo se hace a su nombre. */
    owner: z.email().transform((e) => e.toLowerCase()),
    company: named,
    /** Opcional: un negocio de la compañía del que cuelga la sede. */
    business: named.optional(),
    site: named.extend({ settings: SiteSettingsSchema }),
    /** Años cuyos festivos de ley (art. 74 LFT) se cargan para la compañía. */
    holidayYears: z.array(z.number().int().min(2026).max(2100)).max(5).default([]),
    /** Vigencia de las invitaciones nuevas, en horas (por omisión, la de Axeda). */
    invitationTtlHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
    people: z.array(PersonSchema).max(500).default([]),
  })
  .refine((p) => p.business || !p.people.some((x) => x.role === 'business-admin'), {
    message: 'business-admin necesita "business"',
    path: ['people'],
  });
export type PilotInput = z.infer<typeof PilotSchema>;

/** already-invited: tiene una invitación vigente con ese rol (no se le manda otra). */
export type PersonResult = 'assigned' | 'already-assigned' | 'invited' | 'already-invited';

export interface PilotReport {
  companyId: string;
  businessId: string | null;
  siteId: string;
  /** Qué se creó en esta corrida (lo demás ya existía). */
  created: { company: boolean; business: boolean; site: boolean; siteSettings: boolean };
  holidaysLoaded: number[];
  people: { contact: string; role: PilotRole; result: PersonResult }[];
}

/** Lo que existe en Axeda, buscado por slug (los ids los pone Axeda). */
async function findId(auth: AuthService, sql: string, params: unknown[]) {
  const { rows } = await auth.pool.query<{ id: string; businessId?: string | null }>(sql, params);
  return rows[0] ?? null;
}

/**
 * Deja una compañía lista para el piloto (ADR 0016): compañía, negocio y sede en Axeda, la ubicación
 * y horario de la sede, los festivos de ley y las personas con su rol. Se puede correr las veces que
 * haga falta: lo que ya existe no se duplica, y la configuración de la sede se actualiza a la del
 * archivo. A quien ya tiene cuenta se le asigna el rol; a los demás se les manda una invitación.
 */
export async function setupPilot(
  ctx: INestApplicationContext,
  auth: AuthService,
  input: PilotInput,
  options: { resendInvitations?: boolean } = {},
): Promise<PilotReport> {
  const { axeda } = auth;
  const owner = await findId(auth, 'SELECT id FROM "user" WHERE lower(email) = $1', [input.owner]);
  if (!owner) {
    throw new Error(
      `No existe el usuario ${input.owner}. Regístralo y hazlo dueño (npm run bootstrap:admin).`,
    );
  }
  const actor = { userId: owner.id };
  const created = { company: false, business: false, site: false, siteSettings: false };

  let company = await findId(auth, 'SELECT id FROM "axedaCompany" WHERE slug = $1 AND "deletedAt" IS NULL', [
    input.company.slug,
  ]);
  if (!company) {
    company = await axeda.companies.create(actor, input.company);
    created.company = true;
  }
  const companyId = company.id;

  let businessId: string | null = null;
  if (input.business) {
    let business = await findId(
      auth,
      'SELECT id FROM "axedaBusiness" WHERE "companyId" = $1 AND slug = $2 AND "deletedAt" IS NULL',
      [companyId, input.business.slug],
    );
    if (!business) {
      business = await axeda.businesses.create(actor, companyId, input.business);
      created.business = true;
    }
    businessId = business.id;
  }

  let site = await findId(
    auth,
    'SELECT id, "businessId" FROM "axedaSite" WHERE "companyId" = $1 AND slug = $2 AND "deletedAt" IS NULL',
    [companyId, input.site.slug],
  );
  if (site && (site.businessId ?? null) !== businessId) {
    throw new Error(
      `La sede ${input.site.slug} ya existe con otro negocio. Cámbiala en Axeda o corrige "business" en el archivo.`,
    );
  }
  if (!site) {
    site = await axeda.sites.create(actor, companyId, {
      slug: input.site.slug,
      name: input.site.name,
      ...(businessId ? { businessId } : {}),
    });
    created.site = true;
  }
  const siteId = site.id;

  // La configuración de la sede y los festivos pasan por los mismos servicios que la API, con el
  // contexto que pondría PermissionGuard: RLS con la compañía, auditoría a nombre del dueño.
  const cls = ctx.get<ClsService<RequestContext>>(ClsService, { strict: false });
  const sites = ctx.get(SitesRepository, { strict: false });
  const holidays = ctx.get(HolidaysService, { strict: false });
  await cls.run(async () => {
    cls.set('actor', actor);
    cls.set('companyId', companyId);
    if (businessId) cls.set('businessId', businessId);
    cls.set('siteId', siteId);
    created.siteSettings = !(await sites.findById(siteId));
    await sites.save(input.site.settings);
    for (const year of input.holidayYears) await holidays.statutory(year);
  });

  const roles = (await axeda.roles.list(actor, { limit: 100 })).items;
  const roleId = (key: RoleKey) => {
    const r = roles.find((x) => x.key === key);
    if (!r) throw new Error(`El rol ${key} no está en Axeda: ¿corriste npm run db:migrate?`);
    return r.id;
  };
  const scopeOf = (role: PilotRole): AssignmentScope => {
    if (role === 'company-admin') return { type: 'company', id: companyId };
    if (role === 'business-admin') return { type: 'business', id: businessId! };
    return { type: 'site', id: siteId };
  };

  // Invitaciones pendientes por alcance. Axeda reemplaza la pendiente al invitar otra vez (y manda
  // otro mensaje), así que solo se reenvía si se pide o si cambió el rol.
  const pendingByScope = new Map<string, Invitation[]>();
  const pendingFor = async (scope: AssignmentScope) => {
    const key = `${scope.type}:${'id' in scope ? scope.id : ''}`;
    let found = pendingByScope.get(key);
    if (!found) {
      found = [];
      let cursor: string | undefined;
      do {
        const page = await axeda.invitations.list(
          actor,
          scope,
          { pendingOnly: true },
          { limit: 100, cursor },
        );
        found.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      pendingByScope.set(key, found);
    }
    return found;
  };

  const people: PilotReport['people'] = [];
  for (const p of input.people) {
    const contact = p.email ?? p.phoneNumber!;
    const scope = scopeOf(p.role);
    const user = p.email
      ? await findId(auth, 'SELECT id FROM "user" WHERE lower(email) = $1', [p.email])
      : await findId(auth, 'SELECT id FROM "user" WHERE "phoneNumber" = $1', [p.phoneNumber]);
    let result: PersonResult;
    if (user) {
      try {
        await axeda.assignments.assign(actor, { userId: user.id, roleId: roleId(p.role), scope });
        result = 'assigned';
      } catch (e) {
        if (!isAxedaError(e, 'AXEDA_ASSIGNMENT_EXISTS')) throw e;
        result = 'already-assigned';
      }
    } else {
      const now = Date.now();
      const pending = (await pendingFor(scope)).find(
        (i) =>
          (p.email ? i.email === p.email : i.phoneNumber === p.phoneNumber) &&
          i.expiresAt.getTime() > now &&
          i.roleIds.length === 1 &&
          i.roleIds[0] === roleId(p.role),
      );
      if (pending && !options.resendInvitations) {
        people.push({ contact, role: p.role, result: 'already-invited' });
        continue;
      }
      try {
        await axeda.invitations.create(actor, {
          ...(p.email ? { email: p.email } : { phoneNumber: p.phoneNumber }),
          scope,
          roleIds: [roleId(p.role)],
          ...(input.invitationTtlHours ? { ttlHours: input.invitationTtlHours } : {}),
        });
        result = 'invited';
      } catch (e) {
        if (!isAxedaError(e, 'AXEDA_INVITATION_EXISTS')) throw e;
        result = 'already-invited';
      }
    }
    people.push({ contact, role: p.role, result });
  }

  return { companyId, businessId, siteId, created, holidaysLoaded: input.holidayYears, people };
}
