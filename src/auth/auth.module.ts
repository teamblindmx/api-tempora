import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from './permission.guard.js';

/** El proveedor AUTH lo registra AppModule.forRoot (se crea antes que Nest: ver app.factory.ts). */
@Global()
@Module({
  providers: [{ provide: APP_GUARD, useClass: PermissionGuard }],
})
export class AuthModule {}
