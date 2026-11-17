import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export interface PermissionRequirement {
  permission: Permission;
  /**
   * Parámetro de la ruta con el alcance. Sin él, el permiso se comprueba en global.
   * La compañía de un negocio se lee de la base de datos, nunca de la petición.
   */
  scope?: { company: string } | { business: string };
}

export const PERMISSION_KEY = 'tempora:permission';
export const PUBLIC_KEY = 'tempora:public';

/** La ruta exige sesión y este permiso en el alcance indicado. */
export const RequirePermission = (permission: Permission, scope?: PermissionRequirement['scope']) =>
  SetMetadata(PERMISSION_KEY, { permission, scope } satisfies PermissionRequirement);

/** Ruta pública (sin sesión). Todo lo demás se deniega por defecto. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
