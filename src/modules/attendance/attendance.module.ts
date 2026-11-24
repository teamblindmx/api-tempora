import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsServiceManager } from 'nestjs-cls';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditModule } from '../audit/audit.module.js';
import { PrivacyAcceptedGuard, PrivacyModule } from '../privacy/privacy.module.js';
import {
  AttendanceRecordDto,
  CheckInDto,
  CheckOutDto,
  CreateDailyCodeDto,
  DailyCodeDto,
  MyAttendanceDto,
} from './attendance.schemas.js';
import { AttendanceService, toCodeDto } from './attendance.service.js';
import { CorrectionService } from './corrections.service.js';
import { ExportService } from './export.service.js';
import { HolidaysService } from './holidays.service.js';
import { JustificationService } from './justification.service.js';
import { LEADER_CONTROLLERS } from './leader.controllers.js';
import { LeaderService } from './leader.service.js';
import { OvertimeService } from './overtime.service.js';
import { PeopleDirectory } from './people.js';
import { NoticeService } from './notices.service.js';
import { REVIEW_CONTROLLERS } from './review.controllers.js';
import { RULES_CONTROLLERS } from './rules.controllers.js';

/** Intentos de entrada por usuario y minuto. */
export const CHECK_IN_LIMIT = 10;

/**
 * Tope de intentos de entrada por usuario: el código tiene 6 dígitos, así que adivinarlo a fuerza de
 * intentos no debe ser práctico (10 por minuto son ~300 en la vida de un código de 30 minutos, de un
 * millón posibles). Corre después de PermissionGuard, que ya puso al usuario en el contexto.
 */
@Injectable()
class PerUserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = ClsServiceManager.getClsService<RequestContext>().get('actor')?.userId;
    return Promise.resolve(userId ? `user:${userId}` : `ip:${String(req['ip'])}`);
  }
}

/** El líder (o el encargado) genera y muestra el código diario de su sede. */
@ApiTags('jornada')
@Controller('sites/:siteId/daily-code')
class DailyCodeController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Genera un código nuevo; el anterior vence en ese momento. */
  @Post()
  @RequirePermission(PERMISSIONS.dailyCodeShow, { site: 'siteId' })
  @ZodResponse({ status: 201, type: DailyCodeDto })
  async create(@Param('siteId') _siteId: string, @Body() body: CreateDailyCodeDto) {
    return toCodeDto(await this.attendance.createDailyCode(body.ttlMinutes));
  }

  /** El código vigente, para volver a mostrarlo. 404 si no hay. */
  @Get()
  @RequirePermission(PERMISSIONS.dailyCodeShow, { site: 'siteId' })
  @ZodResponse({ type: DailyCodeDto })
  async current(@Param('siteId') _siteId: string) {
    const code = await this.attendance.currentDailyCode();
    if (!code) throw new NotFoundException('No hay un código vigente en esta sede');
    return toCodeDto(code);
  }
}

/** El trabajador marca su propia entrada y salida en su sede. */
@ApiTags('jornada')
@Controller('sites/:siteId/attendance')
class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('check-in')
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard, PerUserThrottlerGuard)
  @Throttle({ 'check-in': { limit: CHECK_IN_LIMIT, ttl: 60_000 } })
  @ZodResponse({ status: 201, type: AttendanceRecordDto })
  checkIn(@Param('siteId') _siteId: string, @Body() body: CheckInDto) {
    return this.attendance.checkIn(body.code, body.location);
  }

  /**
   * "Registrar entrada tardía" (regla 10): con un código de hoy que ya venció. Queda marcada
   * (`checkInCodeExpired`) y, con horario, como retardo si pasó de la tolerancia. Comparte el tope
   * de intentos con la entrada normal.
   */
  @Post('late-check-in')
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard, PerUserThrottlerGuard)
  @Throttle({ 'check-in': { limit: CHECK_IN_LIMIT, ttl: 60_000 } })
  @ZodResponse({ status: 201, type: AttendanceRecordDto })
  lateCheckIn(@Param('siteId') _siteId: string, @Body() body: CheckInDto) {
    return this.attendance.lateCheckIn(body.code, body.location);
  }

  @Post('check-out')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard)
  @ZodResponse({ type: AttendanceRecordDto })
  checkOut(@Param('siteId') _siteId: string, @Body() body: CheckOutDto) {
    return this.attendance.checkOut(body.location, body.reason);
  }

  /** Mi jornada de hoy en esta sede (para mostrar el botón de entrada o de salida). */
  @Get('me')
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard)
  @ZodResponse({ type: MyAttendanceDto })
  mine(@Param('siteId') _siteId: string) {
    return this.attendance.mine();
  }
}

/**
 * Jornada: código diario, entrada con ubicación y salida (semana 2); panel del líder, marcado
 * manual, calendario y exportación a Excel (semana 3); retardos, entrada tardía, justificaciones,
 * horas extra, festivos y descansos (semanas 5 y 6); corrección de horas, revisión y avisos al líder
 * (semana 7). Las reglas viven en ./rules como funciones puras.
 */
@Module({
  imports: [
    AuditModule,
    PrivacyModule,
    ThrottlerModule.forRoot([{ name: 'check-in', limit: CHECK_IN_LIMIT, ttl: 60_000 }]),
  ],
  controllers: [
    DailyCodeController,
    AttendanceController,
    ...LEADER_CONTROLLERS,
    ...RULES_CONTROLLERS,
    ...REVIEW_CONTROLLERS,
  ],
  providers: [
    AttendanceService,
    LeaderService,
    ExportService,
    OvertimeService,
    JustificationService,
    HolidaysService,
    CorrectionService,
    NoticeService,
    PeopleDirectory,
    PerUserThrottlerGuard,
  ],
})
export class AttendanceModule {}
