import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { Clock } from '../../common/clock.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { fail, shiftOf, toDate, toRecordDto } from './attendance.records.js';
import { ATTENDANCE_ERRORS, type AttendanceRecord } from './attendance.schemas.js';
import { PeopleDirectory } from './people.js';
import { daysInRange, EXPORT_MAX_DAYS } from './rules/panel.js';
import { localDate, wallClock } from './rules/workday.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const STATUS_LABEL: Record<AttendanceRecord['status'], string> = {
  open: 'Abierta',
  'pending-exit': 'Salida pendiente',
  closed: 'Cerrada',
};
const SOURCE_LABEL = { self: 'Trabajador', manual: 'Líder (manual)' } as const;
const KIND_LABEL = { regular: 'Normal', early: 'Anticipada' } as const;

/** Motivos de revisión en palabras, para quien arma la nómina. */
const REVIEW_LABEL: Record<string, string> = {
  'entry:no-location': 'Entrada sin ubicación',
  'entry:outside-radius': 'Entrada fuera del radio',
  'exit:no-location': 'Salida sin ubicación',
  'exit:outside-radius': 'Salida fuera del radio',
  'exit:off-schedule': 'Salida fuera de horario',
};

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

interface Row {
  siteName: string;
  name: string;
  phone: string;
  email: string;
  timezone: string;
  record: AttendanceRecord;
  checkInAt: Date;
  checkOutAt: Date | null;
}

/**
 * Exportación a Excel para nómina: jornadas de un rango de fechas en una sede, un negocio o toda la
 * compañía (según la ruta). Solo horas, nunca dinero (regla 17). Queda en la auditoría quién exportó
 * qué rango, porque son datos de nómina.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly people: PeopleDirectory,
    private readonly cls: ClsService<RequestContext>,
    private readonly clock: Clock,
  ) {}

  async xlsx(from: string, to: string) {
    if (from > to || daysInRange(from, to) > EXPORT_MAX_DAYS) {
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ATTENDANCE_ERRORS.rangeInvalid,
        `El rango va de "from" a "to" y tiene hasta ${EXPORT_MAX_DAYS} días`,
      );
    }
    const siteId = this.cls.get('siteId');
    const businessId = siteId ? undefined : this.cls.get('businessId');
    const scope = siteId
      ? { type: 'site', id: siteId }
      : businessId
        ? { type: 'business', id: businessId }
        : null;
    const now = this.clock.now();

    const records = await this.db.run(async (tx, companyId) => {
      const rows = await tx.attendanceRecord.findMany({
        where: {
          companyId,
          workDate: { gte: toDate(from), lte: toDate(to) },
          ...(siteId ? { siteId } : businessId ? { site: { businessId } } : {}),
        },
        include: { site: true },
        orderBy: [{ workDate: 'asc' }, { checkInAt: 'asc' }],
        take: 100_000,
      });
      await this.audit.record(tx, companyId, {
        action: 'attendance.export',
        targetType: scope?.type ?? 'company',
        targetId: scope?.id ?? companyId,
        after: { from, to, rows: rows.length, format: 'xlsx' },
      });
      return rows;
    });

    const [people, siteNames] = await Promise.all([
      this.people.people(records.map((r) => r.userId)),
      this.people.siteNames(records.map((r) => r.siteId)),
    ]);
    const rows: Row[] = records
      .map((r) => {
        const p = people.get(r.userId);
        return {
          siteName: siteNames.get(r.siteId) ?? r.siteId,
          name: p?.name ?? r.userId,
          phone: p?.phoneNumber ?? '',
          email: p?.email ?? '',
          timezone: r.site.timezone,
          record: toRecordDto(r, localDate(now, r.site.timezone), shiftOf(r.site)),
          checkInAt: r.checkInAt,
          checkOutAt: r.checkOutAt,
        };
      })
      .toSorted(
        (a, b) =>
          a.siteName.localeCompare(b.siteName, 'es') ||
          a.name.localeCompare(b.name, 'es') ||
          a.record.workDate.localeCompare(b.record.workDate),
      );

    const buffer = await writeXlsxFile([
      {
        sheet: 'Jornadas',
        data: this.detail(rows),
        columns: DETAIL_WIDTHS.map((width) => ({ width })),
        stickyRowsCount: 1,
      },
      {
        sheet: 'Resumen',
        data: this.summary(rows),
        columns: SUMMARY_WIDTHS.map((width) => ({ width })),
        stickyRowsCount: 1,
      },
    ]).toBuffer();
    return { buffer, fileName: `tempora-asistencia-${from}-a-${to}.xlsx`, rows: rows.length };
  }

  private detail(rows: Row[]): SheetData {
    const header = [
      'Sede',
      'Empleado',
      'Teléfono',
      'Correo',
      'Fecha',
      'Entrada',
      'Salida',
      'Horas',
      'Estado',
      'Tipo de salida',
      'Motivo de salida',
      'Entrada registrada por',
      'Salida registrada por',
      'Comentario del líder',
      'Por revisar',
      'Id de usuario',
    ].map(bold);
    const data: SheetData = [header];
    for (const { record: r, ...row } of rows) {
      const comments = [
        r.checkInComment && `Entrada: ${r.checkInComment}`,
        r.checkOutComment && `Salida: ${r.checkOutComment}`,
      ].filter(Boolean);
      data.push([
        row.siteName,
        row.name,
        row.phone,
        row.email,
        { value: toDate(r.workDate), format: 'dd/mm/yyyy' },
        { value: wallClock(row.checkInAt, row.timezone), format: 'dd/mm/yyyy hh:mm' },
        row.checkOutAt
          ? { value: wallClock(row.checkOutAt, row.timezone), format: 'dd/mm/yyyy hh:mm' }
          : null,
        r.workedMinutes != null ? { value: hours(r.workedMinutes), format: '0.00' } : null,
        STATUS_LABEL[r.status],
        r.checkOutKind ? KIND_LABEL[r.checkOutKind] : '',
        r.checkOutKind === 'early' ? (r.checkOutReason ?? '') : '',
        SOURCE_LABEL[r.checkInSource],
        r.checkOutSource ? SOURCE_LABEL[r.checkOutSource] : '',
        comments.join(' · '),
        r.reviewReasons.map((x) => REVIEW_LABEL[x] ?? x).join(', '),
        r.userId,
      ]);
    }
    return data;
  }

  /** Una fila por persona y sede: días, horas y lo que hay que revisar antes de pagar. */
  private summary(rows: Row[]): SheetData {
    const header = [
      'Sede',
      'Empleado',
      'Días con jornada',
      'Horas',
      'Salidas anticipadas',
      'Salidas pendientes',
      'Jornadas por revisar',
      'Jornadas con marcado manual',
      'Id de usuario',
    ].map(bold);
    const groups = new Map<
      string,
      { siteName: string; name: string; userId: string; recs: AttendanceRecord[] }
    >();
    for (const row of rows) {
      const key = `${row.siteName}\u0000${row.record.userId}`;
      const g = groups.get(key) ?? {
        siteName: row.siteName,
        name: row.name,
        userId: row.record.userId,
        recs: [],
      };
      g.recs.push(row.record);
      groups.set(key, g);
    }
    const data: SheetData = [header];
    for (const g of groups.values()) {
      data.push([
        g.siteName,
        g.name,
        g.recs.length,
        { value: hours(g.recs.reduce((s, r) => s + (r.workedMinutes ?? 0), 0)), format: '0.00' },
        g.recs.filter((r) => r.checkOutKind === 'early').length,
        g.recs.filter((r) => r.status === 'pending-exit').length,
        g.recs.filter((r) => r.needsReview).length,
        g.recs.filter((r) => r.checkInSource === 'manual' || r.checkOutSource === 'manual').length,
        g.userId,
      ]);
    }
    return data;
  }
}

const DETAIL_WIDTHS = [18, 28, 16, 28, 12, 17, 17, 8, 16, 14, 30, 20, 20, 40, 30, 28];
const SUMMARY_WIDTHS = [18, 28, 16, 10, 18, 18, 20, 26, 28];
