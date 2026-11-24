import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { createPrismaClient } from './prisma-client.js';
import { PRISMA_BASE, TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_BASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPrismaClient(config.DATABASE_URL, config.DB_POOL_MAX),
    },
    TenantDb,
  ],
  exports: [TenantDb, PRISMA_BASE],
})
export class DatabaseModule {}
