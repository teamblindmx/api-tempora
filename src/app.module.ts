import { type DynamicModule, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AUTH, type AuthService } from './auth/auth.js';
import { AuthModule } from './auth/auth.module.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { SitesModule } from './modules/sites/sites.module.js';

/**
 * Compañías y negocios viven en Axeda: el frontend los administra con sus endpoints
 * (/api/auth/axeda/...). Las sedes de Axeda llegan con alpha.2.
 */
@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}

  static forRoot(config: AppConfig, auth: AuthService): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        // Contexto por petición (montado como middleware: existe antes de los guards).
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        AuthModule,
        AuditModule,
        SitesModule,
        EmployeesModule,
        AttendanceModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: AUTH, useValue: auth },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
      ],
      exports: [APP_CONFIG, AUTH],
    };
  }

  async onApplicationShutdown() {
    await this.auth.close();
  }
}
