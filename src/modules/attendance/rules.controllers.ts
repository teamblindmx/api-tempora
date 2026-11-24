import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { PrivacyAcceptedGuard } from '../privacy/privacy.module.js';
import {
  ApproveJustificationDto,
  AuthorizeOvertimeDto,
  CreateHolidayDto,
  DayQueryDto,
  HolidayDto,
  HolidayListDto,
  HolidayQueryDto,
  JustificationDto,
  JustificationListDto,
  JustificationQueryDto,
  OvertimeAuthorizationDto,
  OvertimeDayDto,
  RejectJustificationDto,
  StatutoryHolidaysDto,
  SubmitJustificationDto,
} from './attendance.schemas.js';
import { HolidaysService } from './holidays.service.js';
import { JustificationService } from './justification.service.js';
import { OvertimeService } from './overtime.service.js';

/** Horas extra (regla 9): el líder autoriza antes o en vivo, y cierra la jornada abierta. */
@ApiTags('horas extra')
@Controller('sites/:siteId/overtime')
class OvertimeController {
  constructor(private readonly overtime: OvertimeService) {}

  /**
   * Autoriza horas extra a un trabajador de la sede para un día (hoy por omisión): hasta `until`, o
   * jornada abierta con `until: null`. Si ya había una sin cerrar, la reemplaza.
   */
  @Post()
  @RequirePermission(PERMISSIONS.overtimeAuthorize, { site: 'siteId' })
  @ZodResponse({ status: 201, type: OvertimeAuthorizationDto })
  authorize(@Param('siteId') _siteId: string, @Body() body: AuthorizeOvertimeDto) {
    return this.overtime.authorize(body);
  }

  /** Cierra la autorización ahora: lo trabajado después es "tiempo no autorizado". */
  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.overtimeAuthorize, { site: 'siteId' })
  @ZodResponse({ type: OvertimeAuthorizationDto })
  close(@Param('siteId') _siteId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.overtime.close(id);
  }

  /** Autorizaciones del día (`?date=`), con la jornada y sus minutos. */
  @Get()
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: OvertimeDayDto })
  list(@Param('siteId') _siteId: string, @Query() query: DayQueryDto) {
    return this.overtime.list(query.date);
  }
}

/** Justificaciones (regla 12, versión simple): el trabajador escribe, el líder aprueba o rechaza. */
@ApiTags('justificaciones')
@Controller('sites/:siteId/justifications')
class JustificationController {
  constructor(private readonly justifications: JustificationService) {}

  /** El trabajador justifica un retardo, una salida anticipada o una falta suya en esta sede. */
  @Post()
  @RequirePermission(PERMISSIONS.justificationWrite, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard)
  @ZodResponse({ status: 201, type: JustificationDto })
  submit(@Param('siteId') _siteId: string, @Body() body: SubmitJustificationDto) {
    return this.justifications.submit(body);
  }

  /** Mis justificaciones en esta sede. */
  @Get('me')
  @RequirePermission(PERMISSIONS.justificationWrite, { site: 'siteId' })
  @UseGuards(PrivacyAcceptedGuard)
  @ZodResponse({ type: [JustificationDto] })
  mine(@Param('siteId') _siteId: string) {
    return this.justifications.mine();
  }

  /** Para el líder: las de la sede (`?status=pending`), del último mes por omisión. */
  @Get()
  @RequirePermission(PERMISSIONS.justificationResolve, { site: 'siteId' })
  @ZodResponse({ type: JustificationListDto })
  list(@Param('siteId') _siteId: string, @Query() query: JustificationQueryDto) {
    return this.justifications.list(query);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.justificationResolve, { site: 'siteId' })
  @ZodResponse({ type: JustificationDto })
  approve(
    @Param('siteId') _siteId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveJustificationDto,
  ) {
    return this.justifications.resolve(id, 'approved', body.comment);
  }

  /** Rechazo con comentario obligatorio. Es final hasta que exista la disputa con RH. */
  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.justificationResolve, { site: 'siteId' })
  @ZodResponse({ type: JustificationDto })
  reject(
    @Param('siteId') _siteId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectJustificationDto,
  ) {
    return this.justifications.resolve(id, 'rejected', body.comment);
  }
}

/** Días festivos de la compañía (todas sus sedes) o de una sede (regla 15). */
@ApiTags('festivos')
@Controller()
class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  /** Festivos de la compañía y de todas sus sedes (`?year=`). */
  @Get('companies/:companyId/holidays')
  @RequirePermission(PERMISSIONS.siteRead, { company: 'companyId' })
  @ZodResponse({ type: HolidayListDto })
  companyList(@Param('companyId') _companyId: string, @Query() query: HolidayQueryDto) {
    return this.holidays.list(query.year);
  }

  /** Festivo para todas las sedes de la compañía. */
  @Post('companies/:companyId/holidays')
  @RequirePermission(PERMISSIONS.holidayManage, { company: 'companyId' })
  @ZodResponse({ status: 201, type: HolidayDto })
  companyCreate(@Param('companyId') _companyId: string, @Body() body: CreateHolidayDto) {
    return this.holidays.create(body.date, body.name);
  }

  /** Carga los festivos del art. 74 de la LFT de un año (los que falten). No incluye día de elecciones. */
  @Post('companies/:companyId/holidays/statutory')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.holidayManage, { company: 'companyId' })
  @ZodResponse({ type: HolidayListDto })
  statutory(@Param('companyId') _companyId: string, @Body() body: StatutoryHolidaysDto) {
    return this.holidays.statutory(body.year);
  }

  @Delete('companies/:companyId/holidays/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.holidayManage, { company: 'companyId' })
  async remove(@Param('companyId') _companyId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.holidays.remove(id);
  }

  /** Los festivos que valen en la sede: los de la compañía y los suyos. */
  @Get('sites/:siteId/holidays')
  @RequirePermission(PERMISSIONS.siteRead, { site: 'siteId' })
  @ZodResponse({ type: HolidayListDto })
  siteList(@Param('siteId') _siteId: string, @Query() query: HolidayQueryDto) {
    return this.holidays.list(query.year);
  }

  /** Festivo solo de esta sede (fiesta local). */
  @Post('sites/:siteId/holidays')
  @RequirePermission(PERMISSIONS.holidayManage, { site: 'siteId' })
  @ZodResponse({ status: 201, type: HolidayDto })
  siteCreate(@Param('siteId') _siteId: string, @Body() body: CreateHolidayDto) {
    return this.holidays.create(body.date, body.name);
  }
}

export const RULES_CONTROLLERS = [OvertimeController, JustificationController, HolidaysController];
