import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import { AuditService } from './audit.service.js';

class AuditQueryDto extends createZodDto(
  z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
) {}

@ApiTags('auditoría')
@Controller('companies/:companyId/audit')
class AuditController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @RequirePermission(PERMISSIONS.auditRead, { company: 'companyId' })
  list(@Param('companyId') _companyId: string, @Query() q: AuditQueryDto) {
    return this.db.run((tx, companyId) =>
      tx.auditLog
        .findMany({ where: { companyId }, orderBy: { id: 'desc' }, take: q.limit })
        .then((rows) => rows.map((r) => ({ ...r, id: r.id.toString() }))),
    );
  }
}

@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
