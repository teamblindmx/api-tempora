import type { Actor } from '@teamblind/axeda-core';
import type { ClsStore } from 'nestjs-cls';

/** Lo que se guarda por petición con nestjs-cls. Lo llena PermissionGuard. */
export interface RequestContext extends ClsStore {
  /** Quién hace la petición (de la sesión de Better Auth, nunca del cliente). */
  actor?: Actor;
  /** Compañía de la ruta, ya validada contra Axeda. Es la que fija RLS. */
  companyId?: string;
  /** Negocio, si la ruta es de negocio. Su compañía se leyó de la base de datos. */
  businessId?: string;
}
