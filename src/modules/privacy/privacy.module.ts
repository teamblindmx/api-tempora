import {
  Body,
  type CanActivate,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { Clock } from '../../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';

export const PRIVACY_ERRORS = {
  /** Hay que aceptar el aviso de privacidad vigente antes de usar la jornada. */
  notAccepted: 'TEMPORA_PRIVACY_NOT_ACCEPTED',
  /** Se aceptó una versión que no es la vigente (el frontend mostró un texto viejo). */
  versionMismatch: 'TEMPORA_PRIVACY_VERSION_MISMATCH',
} as const;

class PrivacyStatusDto extends createZodDto(
  z.object({
    /** Versión vigente: el frontend muestra el texto de esta versión. */
    version: z.string(),
    accepted: z.boolean(),
    acceptedAt: z.iso.datetime().nullable(),
  }),
) {}

class AcceptPrivacyDto extends createZodDto(
  z.object({
    /** La versión que la persona leyó. Debe ser la vigente. */
    version: z.string().trim().min(1).max(40),
  }),
) {}

/**
 * Aceptación del aviso de privacidad (requisito no funcional del PRD; pendientes legales 1, 2 y 9).
 * Es por compañía, porque el aviso es del patrón: quien trabaja en dos compañías acepta en cada una.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get version() {
    return this.config.PRIVACY_NOTICE_VERSION;
  }

  private userId() {
    const id = this.cls.get('actor')?.userId;
    if (!id) throw new Error('El aviso de privacidad necesita una sesión');
    return id;
  }

  async status() {
    const userId = this.userId();
    const row = await this.db.run((tx, companyId) =>
      tx.privacyAcceptance.findFirst({ where: { companyId, userId, version: this.version } }),
    );
    return { version: this.version, accepted: !!row, acceptedAt: row?.acceptedAt.toISOString() ?? null };
  }

  /** Guarda la aceptación (una vez por versión) y la audita. Si ya estaba, devuelve la de antes. */
  async accept(version: string) {
    if (version !== this.version) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: PRIVACY_ERRORS.versionMismatch,
          message: 'El aviso cambió: vuelve a leerlo antes de aceptarlo',
          version: this.version,
        },
        HttpStatus.CONFLICT,
      );
    }
    const userId = this.userId();
    const actor = this.cls.get('actor');
    const now = this.clock.now();
    try {
      return await this.db.run(async (tx, companyId) => {
        const existing = await tx.privacyAcceptance.findFirst({ where: { companyId, userId, version } });
        if (existing) return { version, accepted: true, acceptedAt: existing.acceptedAt.toISOString() };
        const row = await tx.privacyAcceptance.create({
          data: {
            companyId,
            userId,
            version,
            acceptedAt: now,
            ip: actor?.ip ?? null,
            userAgent: actor?.userAgent?.slice(0, 500) ?? null,
          },
        });
        await this.audit.record(tx, companyId, {
          action: 'privacy.accept',
          targetType: 'privacy-acceptance',
          targetId: row.id,
          after: { userId, version, acceptedAt: now.toISOString() },
        });
        return { version, accepted: true, acceptedAt: now.toISOString() };
      });
    } catch (e) {
      // Dos aceptaciones simultáneas: la segunda choca con el índice único y ya está aceptado.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.status();
      throw e;
    }
  }
}

/**
 * Bloquea la jornada hasta aceptar el aviso vigente. Va en cada ruta en la que el usuario marca o ve
 * su propia asistencia (los datos personales que cubre el aviso). Corre después de PermissionGuard,
 * que ya fijó la compañía y el usuario. 403 con código TEMPORA_PRIVACY_NOT_ACCEPTED.
 */
@Injectable()
export class PrivacyAcceptedGuard implements CanActivate {
  constructor(private readonly privacy: PrivacyService) {}

  async canActivate(): Promise<boolean> {
    const { accepted, version } = await this.privacy.status();
    if (accepted) return true;
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: PRIVACY_ERRORS.notAccepted,
        message: 'Antes de registrar tu asistencia, lee y acepta el aviso de privacidad',
        version,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** El trabajador ve y acepta el aviso desde su sede (el frontend ya la conoce). */
@ApiTags('aviso de privacidad')
@Controller('sites/:siteId/privacy-notice')
class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** ¿Ya aceptó la versión vigente en la compañía de esta sede? */
  @Get()
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @ZodResponse({ type: PrivacyStatusDto })
  status(@Param('siteId') _siteId: string) {
    return this.privacy.status();
  }

  /** Acepta la versión vigente. Idempotente. */
  @Post('accept')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @ZodResponse({ type: PrivacyStatusDto })
  accept(@Param('siteId') _siteId: string, @Body() body: AcceptPrivacyDto) {
    return this.privacy.accept(body.version);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [PrivacyController],
  providers: [PrivacyService, PrivacyAcceptedGuard],
  exports: [PrivacyService, PrivacyAcceptedGuard],
})
export class PrivacyModule {}
