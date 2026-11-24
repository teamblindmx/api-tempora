import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import {
  AttendanceRecordDto,
  CorrectRecordDto,
  NoticeDto,
  NoticeListDto,
  NoticeQueryDto,
  RecordDetailDto,
  ReviewQueryDto,
  ReviewQueueDto,
  ReviewRecordDto,
} from './attendance.schemas.js';
import { CorrectionService } from './corrections.service.js';
import { NoticeService } from './notices.service.js';

/**
 * Semana 7 (ADR 0015): el líder corrige horas, revisa lo que quedó "por revisar" y ve el historial
 * de cada jornada. El encargado ve la lista y el detalle, pero no corrige ni revisa.
 */
@ApiTags('jornada')
@Controller('sites/:siteId/attendance')
class RecordsController {
  constructor(private readonly corrections: CorrectionService) {}

  /** Jornadas con motivos sin revisar (`?from=&to=`, por omisión el último mes). */
  @Get('review')
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: ReviewQueueDto })
  queue(@Param('siteId') _siteId: string, @Query() query: ReviewQueryDto) {
    return this.corrections.queue(query);
  }

  /** Una jornada con la persona y su historial de correcciones. */
  @Get('records/:id')
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: RecordDetailDto })
  detail(@Param('siteId') _siteId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.corrections.detail(id);
  }

  /**
   * Corrige la hora de entrada o de salida (hasta 31 días atrás), con comentario obligatorio. Queda en
   * el historial con el valor anterior y el nuevo. No agrega una salida que falta: eso es
   * `manual/check-out`.
   */
  @Post('records/:id/correct')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceCorrect, { site: 'siteId' })
  @ZodResponse({ type: AttendanceRecordDto })
  correct(
    @Param('siteId') _siteId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CorrectRecordDto,
  ) {
    return this.corrections.correct(id, body);
  }

  /** Marca como revisados los motivos que tiene la jornada (`comment` opcional). */
  @Post('records/:id/review')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceCorrect, { site: 'siteId' })
  @ZodResponse({ type: AttendanceRecordDto })
  review(
    @Param('siteId') _siteId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewRecordDto,
  ) {
    return this.corrections.review(id, body.comment);
  }
}

/** Avisos de la sede para sus líderes (regla 8): jornadas por revisar y justificaciones nuevas. */
@ApiTags('avisos')
@Controller('sites/:siteId/notices')
class NoticesController {
  constructor(private readonly notices: NoticeService) {}

  /** Pendientes (por omisión) o todos los del último mes (`?status=all`), con cuántos siguen pendientes. */
  @Get()
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: NoticeListDto })
  list(@Param('siteId') _siteId: string, @Query() query: NoticeQueryDto) {
    return this.notices.list(query.status);
  }

  /** "Ya lo vi": lo quita de pendientes para todos los líderes de la sede. */
  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: NoticeDto })
  read(@Param('siteId') _siteId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.notices.markRead(id);
  }
}

export const REVIEW_CONTROLLERS = [RecordsController, NoticesController];
