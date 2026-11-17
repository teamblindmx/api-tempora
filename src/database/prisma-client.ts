import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../../generated/prisma/client.js';

export type TransactionClient = Prisma.TransactionClient;

/**
 * Cliente de Prisma 7 con @prisma/adapter-pg. En Prisma 7 el driver pg no tiene tiempo máximo de
 * conexión por defecto: se fija aquí.
 */
export function createPrismaClient(connectionString: string, max: number) {
  const adapter = new PrismaPg({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

export type BasePrisma = ReturnType<typeof createPrismaClient>;

/**
 * Abre una transacción con la compañía fijada para RLS. set_config(..., true) vale solo dentro de
 * esta transacción: no pasa a la siguiente petición que reutilice la conexión.
 */
export function withCompany<T>(
  base: BasePrisma,
  companyId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = { timeout: 10_000, maxWait: 5_000 },
): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return fn(tx);
  }, options);
}
