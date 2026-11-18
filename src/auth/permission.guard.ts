import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AssignmentScope, TargetScope } from '@teamblind/axeda-core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { RequestContext } from '../tenancy/request-context.js';
import { AUTH, type AuthService } from './auth.js';
import { isCrossSiteWrite, toHeaders } from './http.js';
import { PERMISSION_KEY, type PermissionRequirement, PUBLIC_KEY } from './require-permission.decorator.js';
import { TENANT_DATA_PERMISSIONS } from './permissions.js';

/**
 * Guard global. Se deniega por defecto: toda ruta necesita @RequirePermission o @Public.
 *
 * 1. CSRF: una escritura con cookie debe venir de un origen de confianza.
 * 2. Sesión de Better Auth → Principal de Axeda (401 si no hay).
 * 3. Alcance: el id de la ruta se resuelve leyendo la base de Axeda (404 si no existe, igual que 403).
 * 4. Permiso con Axeda en ese alcance (403). Los permisos de datos de clientes no cuentan si solo
 *    vienen de un alcance global (el dueño de la plataforma no ve nómina).
 *    Alcances: compañía, negocio o sede; una asignación de compañía vale en sus negocios y sedes.
 * 5. Guarda quién y en qué compañía en el contexto de la petición; de ahí sale la compañía de RLS.
 */
/** ¿Viene la concesión de la compañía, el negocio o la sede de `target` (no de global)? */
export function grantsFromTenant(s: AssignmentScope, target: TargetScope): boolean {
  if (target.type === 'global' || s.type === 'global') return false;
  if (s.type === 'company') return s.id === target.companyId;
  if (s.type === 'business') return 'businessId' in target && target.businessId === s.id;
  return target.type === 'site' && target.siteId === s.id;
}

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestContext>,
    @Inject(AUTH) private readonly auth: AuthService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.trusted = new Set([...config.TRUSTED_ORIGINS, config.BETTER_AUTH_URL].map((o) => new URL(o).origin));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION_KEY, targets);
    if (!req) throw new InternalServerErrorException('Ruta sin @RequirePermission ni @Public');

    const http = ctx.switchToHttp().getRequest<Request>();
    if (isCrossSiteWrite(http.method, http.headers, this.trusted)) throw new ForbiddenException();

    const principal = await this.auth.principal({ headers: toHeaders(http.headers) });
    if (!principal) throw new UnauthorizedException();
    if (principal.banned) throw new ForbiddenException();

    const target = await this.resolveTarget(req, http);
    const { axeda } = this.auth;
    if (!(await axeda.can(principal, req.permission, target))) throw new ForbiddenException();

    // Los datos de clientes solo se conceden desde la compañía, el negocio o la sede: nunca desde global.
    if (TENANT_DATA_PERMISSIONS.has(req.permission)) {
      const scopes = await axeda.scopesFor(principal, req.permission);
      if (!scopes.some((s) => grantsFromTenant(s, target))) throw new ForbiddenException();
    }

    this.cls.set('actor', {
      ...principal,
      ip: http.ip,
      userAgent: http.get('user-agent') ?? undefined,
    });
    if (target.type !== 'global') this.cls.set('companyId', target.companyId);
    if ((target.type === 'business' || target.type === 'site') && target.businessId) {
      this.cls.set('businessId', target.businessId);
    }
    if (target.type === 'site') this.cls.set('siteId', target.siteId);
    return true;
  }

  private async resolveTarget(req: PermissionRequirement, http: Request): Promise<TargetScope> {
    if (!req.scope) return { type: 'global' };
    const [type, param] =
      'company' in req.scope
        ? (['company', req.scope.company] as const)
        : 'business' in req.scope
          ? (['business', req.scope.business] as const)
          : (['site', req.scope.site] as const);
    const id = http.params[param];
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new ForbiddenException();
    const scope: AssignmentScope = { type, id };
    const target = await this.auth.axeda.resolveTarget(scope);
    // Mismo 403 si no existe o si no es tuyo: no revela qué compañías existen.
    if (!target) throw new ForbiddenException();
    return target;
  }
}
