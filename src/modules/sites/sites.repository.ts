import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../database/tenant-db.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { CreateSiteInput } from './sites.schemas.js';

/** Segunda capa de aislamiento: además de RLS, cada consulta filtra por companyId. */
@Injectable()
export class SitesRepository {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.run((tx, companyId) =>
      tx.site.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    );
  }

  findById(id: string) {
    return this.db.run((tx, companyId) => tx.site.findFirst({ where: { id, companyId } }));
  }

  create(input: CreateSiteInput) {
    return this.db.run(async (tx, companyId) => {
      const site = await tx.site.create({ data: { ...input, companyId } });
      await this.audit.record(tx, companyId, {
        action: 'site.create',
        targetType: 'site',
        targetId: site.id,
        after: { ...input },
      });
      return site;
    });
  }
}
