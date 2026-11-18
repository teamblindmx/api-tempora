import { Inject, Injectable } from '@nestjs/common';
import { AUTH, type AuthService } from '../../auth/auth.js';
import { PERMISSIONS } from '../../auth/permissions.js';

/** Una persona, como la muestran el panel y la exportación. */
export interface Person {
  userId: string;
  name: string;
  phoneNumber: string | null;
  /** Null si solo entra por teléfono (Axeda le pone un correo de relleno @phone.invalid). */
  email: string | null;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
}

const toPerson = (u: UserRow): Person => ({
  userId: u.id,
  name: u.name,
  phoneNumber: u.phoneNumber,
  email: u.email.endsWith('@phone.invalid') ? null : u.email,
});

/**
 * Lectura de personas y sedes de Axeda (esquema auth) para el panel y la exportación. Solo lee, con
 * el pool de Better Auth: tempora_app no tiene acceso a auth. El permiso sobre la sede o la compañía
 * ya lo comprobó PermissionGuard; los ids llegan del contexto o de filas ya filtradas por RLS.
 */
@Injectable()
export class PeopleDirectory {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}

  /**
   * Plantilla de la sede: quien tiene una asignación vigente en esa sede con un rol que marca
   * asistencia. Se decide por el permiso, no por el nombre del rol. No incluye a bloqueados.
   */
  async siteRoster(siteId: string, at: Date): Promise<Person[]> {
    const { rows } = await this.auth.pool.query<UserRow>(
      `SELECT DISTINCT u.id, u.name, u.email, u."phoneNumber"
         FROM "axedaAssignment" a
         JOIN "axedaRole" r ON r.id = a."roleId"
         JOIN "user" u ON u.id = a."userId"
        WHERE a."scopeType" = 'site' AND a."scopeId" = $1
          AND (a."expiresAt" IS NULL OR a."expiresAt" > $2)
          AND r.status = 'active' AND r.permissions ? $3
          AND u.banned IS NOT TRUE
        ORDER BY u.name, u.id`,
      [siteId, at, PERMISSIONS.attendanceMark],
    );
    return rows.map(toPerson);
  }

  /** Personas por id (las que no existan no aparecen). */
  async people(userIds: readonly string[]): Promise<Map<string, Person>> {
    if (userIds.length === 0) return new Map();
    const { rows } = await this.auth.pool.query<UserRow>(
      `SELECT id, name, email, "phoneNumber" FROM "user" WHERE id = ANY($1)`,
      [[...new Set(userIds)]],
    );
    return new Map(rows.map((u) => [u.id, toPerson(u)]));
  }

  /** Nombres de sedes de Axeda por id. */
  async siteNames(siteIds: readonly string[]): Promise<Map<string, string>> {
    if (siteIds.length === 0) return new Map();
    const { rows } = await this.auth.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM "axedaSite" WHERE id = ANY($1)`,
      [[...new Set(siteIds)]],
    );
    return new Map(rows.map((s) => [s.id, s.name]));
  }
}
