import { Body, Controller, Get, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import {
  AttendanceRecordDto,
  CalendarDto,
  CalendarQueryDto,
  DayQueryDto,
  ExportQueryDto,
  ManualCheckInDto,
  ManualCheckOutDto,
  SiteDayDto,
} from './attendance.schemas.js';
import { ExportService, XLSX_TYPE } from './export.service.js';
import { LeaderService } from './leader.service.js';

const xlsxResponse = (file: { buffer: Buffer; fileName: string }) =>
  new StreamableFile(file.buffer, {
    type: XLSX_TYPE,
    disposition: `attachment; filename="${file.fileName}"`,
    length: file.buffer.length,
  });

const XlsxDocs = () => (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
  ApiProduces(XLSX_TYPE)(target, key, descriptor);
  ApiOkResponse({
    description: 'Libro de Excel con las hojas "Jornadas" y "Resumen"',
    content: { [XLSX_TYPE]: { schema: { type: 'string', format: 'binary' } } },
  })(target, key, descriptor);
};

/**
 * El líder en su sede: panel del día, marcado manual y calendario de cada trabajador. El encargado
 * entra con los permisos que le preste el líder (ADR 0007); el trabajador solo ve su calendario.
 */
@ApiTags('jornada')
@Controller('sites/:siteId/attendance')
class LeaderController {
  constructor(
    private readonly leader: LeaderService,
    private readonly exports: ExportService,
  ) {}

  /** Quién llegó y quién falta en la sede (hoy, o `?date=YYYY-MM-DD`), con las salidas pendientes. */
  @Get('day')
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: SiteDayDto })
  day(@Param('siteId') _siteId: string, @Query() query: DayQueryDto) {
    return this.leader.day(query.date);
  }

  /** Entrada registrada por el líder por un trabajador de la sede, con comentario obligatorio. */
  @Post('manual/check-in')
  @RequirePermission(PERMISSIONS.attendanceMarkManual, { site: 'siteId' })
  @ZodResponse({ status: 201, type: AttendanceRecordDto })
  manualCheckIn(@Param('siteId') _siteId: string, @Body() body: ManualCheckInDto) {
    return this.leader.manualCheckIn(body.userId, body.comment, body.at);
  }

  /** Salida registrada por el líder: cierra la jornada abierta o una salida pendiente (con su hora). */
  @Post('manual/check-out')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.attendanceMarkManual, { site: 'siteId' })
  @ZodResponse({ type: AttendanceRecordDto })
  manualCheckOut(@Param('siteId') _siteId: string, @Body() body: ManualCheckOutDto) {
    return this.leader.manualCheckOut(body.userId, body.comment, body.at, body.workDate);
  }

  /** Mi calendario del mes en esta sede (`?month=YYYY-MM`). */
  @Get('me/calendar')
  @RequirePermission(PERMISSIONS.attendanceMark, { site: 'siteId' })
  @ZodResponse({ type: CalendarDto })
  myCalendar(@Param('siteId') _siteId: string, @Query() query: CalendarQueryDto) {
    return this.leader.calendar(null, query.month);
  }

  /** Calendario de un trabajador en la sede, para el líder. */
  @Get('users/:userId/calendar')
  @RequirePermission(PERMISSIONS.attendanceRead, { site: 'siteId' })
  @ZodResponse({ type: CalendarDto })
  userCalendar(
    @Param('siteId') _siteId: string,
    @Param('userId') userId: string,
    @Query() query: CalendarQueryDto,
  ) {
    return this.leader.calendar(userId, query.month);
  }

  /** Excel para nómina de la sede (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, hasta 62 días). */
  @Get('export')
  @RequirePermission(PERMISSIONS.reportExport, { site: 'siteId' })
  @XlsxDocs()
  async export(@Param('siteId') _siteId: string, @Query() query: ExportQueryDto) {
    return xlsxResponse(await this.exports.xlsx(query.from, query.to));
  }
}

/** Excel para nómina de un negocio o de toda la compañía (administradores). */
@ApiTags('jornada')
@Controller()
class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get('businesses/:businessId/attendance/export')
  @RequirePermission(PERMISSIONS.reportExport, { business: 'businessId' })
  @XlsxDocs()
  async business(@Param('businessId') _businessId: string, @Query() query: ExportQueryDto) {
    return xlsxResponse(await this.exports.xlsx(query.from, query.to));
  }

  @Get('companies/:companyId/attendance/export')
  @RequirePermission(PERMISSIONS.reportExport, { company: 'companyId' })
  @XlsxDocs()
  async company(@Param('companyId') _companyId: string, @Query() query: ExportQueryDto) {
    return xlsxResponse(await this.exports.xlsx(query.from, query.to));
  }
}

export const LEADER_CONTROLLERS = [LeaderController, ExportController];
