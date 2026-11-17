import { Inject, Injectable, InternalServerErrorException, type OnModuleDestroy } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../tenancy/request-context.js';
import { type BasePrisma, type TransactionClient, withCompany } from './prisma-client.js';

export const PRISMA_BASE = Symbol('PRISMA_BASE');

/**
 * Único acceso a las tablas de Tempora. Toda operación corre en una transacción con la compañía de
 * la petición fijada para RLS. Solo la usan los repositorios; los controladores nunca tocan Prisma.
 */
@Injectable()
export class TenantDb implements OnModuleDestroy {
  constructor(
    @Inject(PRISMA_BASE) private readonly base: BasePrisma,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  /** Compañía de la petición. Falla si la ruta no pasó por PermissionGuard con una compañía. */
  companyId(): string {
    const companyId = this.cls.isActive() ? this.cls.get('companyId') : undefined;
    if (!companyId) throw new InternalServerErrorException('Operación de datos sin compañía en el contexto');
    return companyId;
  }

  /** Transacción con la compañía de la petición actual. */
  async run<T>(fn: (tx: TransactionClient, companyId: string) => Promise<T>): Promise<T> {
    const companyId = this.companyId();
    return withCompany(this.base, companyId, (tx) => fn(tx, companyId));
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
