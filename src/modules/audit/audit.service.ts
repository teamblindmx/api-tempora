import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import type { RequestContext } from '../../tenancy/request-context.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** Obligatorio en todo ajuste manual (reglas de jornada, 13). */
  reason?: string;
}

/** Escribe en audit_log dentro de la misma transacción que el cambio: o quedan los dos o ninguno. */
@Injectable()
export class AuditService {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  async record(tx: TransactionClient, companyId: string, entry: AuditEntry) {
    await tx.auditLog.create({
      data: { companyId, actorUserId: this.cls.get('actor')?.userId ?? null, ...entry },
    });
  }
}
