import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import type { SiteSettingsInput } from './sites.schemas.js';

/** Segunda capa de aislamiento: además de RLS, cada consulta filtra por companyId. */
@Injectable()
export class SitesRepository {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  list() {
    return this.db.run((tx, companyId) =>
      tx.site.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    );
  }

  findById(id: string) {
    return this.db.run((tx, companyId) => tx.site.findFirst({ where: { id, companyId } }));
  }

  /** Crea o actualiza los datos de la sede de la ruta (su id, compañía y negocio ya los validó Axeda). */
  save(input: SiteSettingsInput) {
    const siteId = this.cls.get('siteId');
    const businessId = this.cls.get('businessId') ?? null;
    if (!siteId) throw new Error('save() necesita una ruta de sede');
    return this.db.run(async (tx, companyId) => {
      const before = await tx.site.findFirst({ where: { id: siteId, companyId } });
      const site = await tx.site.upsert({
        where: { id: siteId },
        create: { id: siteId, companyId, businessId, ...input },
        update: { businessId, ...input },
      });
      await this.audit.record(tx, companyId, {
        action: before ? 'site.update' : 'site.create',
        targetType: 'site',
        targetId: siteId,
        before: before
          ? {
              latitude: before.latitude.toNumber(),
              longitude: before.longitude.toNumber(),
              radiusM: before.radiusM,
              timezone: before.timezone,
            }
          : undefined,
        after: { ...input },
      });
      return site;
    });
  }
}
