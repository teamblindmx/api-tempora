import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { Clock } from '../../common/clock.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { dayKey, fail, fromDate, shiftOf, toDate, toRecordDto } from './attendance.records.js';
import { type DayInfo, dayInfo } from './rules/calendar.js';
import { asKind, asStatus } from './rules/justification.js';
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
const DAY_LABEL = { ordinary: 'Ordinario', sunday: 'Domingo', rest: 'Descanso', holiday: 'Festivo' } as const;
const JUSTIFICATION_LABEL = { late: 'Retardo', 'early-exit': 'Salida anticipada', absence: 'Falta' } as const;
const JSTATUS_LABEL = { pending: 'pendiente', approved: 'aprobada', rejected: 'rechazada' } as const;
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
  day: DayInfo;
  justifications: string;
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

    const data = await this.db.run(async (tx, companyId) => {
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
      const range = { gte: toDate(from), lte: toDate(to) };
      const [holidays, auths, justifications] = await Promise.all([
        tx.holiday.findMany({ where: { companyId, date: range } }),
        tx.overtimeAuthorization.findMany({ where: { companyId, workDate: range } }),
        tx.justification.findMany({ where: { companyId, workDate: range }, orderBy: { submittedAt: 'asc' } }),
      ]);
      await this.audit.record(tx, companyId, {
        action: 'attendance.export',
        targetType: scope?.type ?? 'company',
        targetId: scope?.id ?? companyId,
        after: { from, to, rows: rows.length, format: 'xlsx' },
      });
      return { rows, holidays, auths, justifications };
    });
    // Un festivo de la sede gana al de la compañía (mismo criterio que work-calendar.ts).
    const holidayName = (recordSite: string, date: string) =>
      data.holidays.find((h) => h.siteId === recordSite && fromDate(h.date) === date)?.name ??
      data.holidays.find((h) => h.siteId === null && fromDate(h.date) === date)?.name ??
      null;
    const authOf = new Map(data.auths.map((a) => [dayKey(a.userId, a.workDate), a]));
    const justOf = (userId: string, date: string) =>
      data.justifications
        .filter((j) => j.userId === userId && fromDate(j.workDate) === date)
        .map((j) => `${JUSTIFICATION_LABEL[asKind(j.kind)]} (${JSTATUS_LABEL[asStatus(j.status)]})`)
        .join(', ');
    const records = data.rows;

    const [people, siteNames] = await Promise.all([
      this.people.people(records.map((r) => r.userId)),
      this.people.siteNames(records.map((r) => r.siteId)),
    ]);
    const rows: Row[] = records
      .map((r) => {
        const p = people.get(r.userId);
        const date = fromDate(r.workDate);
        return {
          day: dayInfo(date, r.site.restDays, holidayName(r.siteId, date)),
          justifications: justOf(r.userId, date),
          siteName: siteNames.get(r.siteId) ?? r.siteId,
          name: p?.name ?? r.userId,
          phone: p?.phoneNumber ?? '',
          email: p?.email ?? '',
          timezone: r.site.timezone,
          record: toRecordDto(r, localDate(now, r.site.timezone), shiftOf(r.site), {
            timezone: r.site.timezone,
            now,
            authorization: authOf.get(dayKey(r.userId, r.workDate)) ?? null,
          }),
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
      'Tipo de día',
      'Domingo',
      'Entrada',
      'Salida',
      'Horas',
      'Retardo',
      'Minutos tras la entrada oficial',
      'Entrada tardía (código vencido)',
      'Horas extra autorizadas',
      'Tiempo no autorizado (horas)',
      'Estado',
      'Tipo de salida',
      'Motivo de salida',
      'Entrada registrada por',
      'Salida registrada por',
      'Comentario del líder',
      'Por revisar',
      'Justificaciones',
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
        row.day.holidayName
          ? `${DAY_LABEL[row.day.dayType]}: ${row.day.holidayName}`
          : DAY_LABEL[row.day.dayType],
        row.day.sunday ? 'Sí' : '',
        { value: wallClock(row.checkInAt, row.timezone), format: 'dd/mm/yyyy hh:mm' },
        row.checkOutAt
          ? { value: wallClock(row.checkOutAt, row.timezone), format: 'dd/mm/yyyy hh:mm' }
          : null,
        r.workedMinutes != null ? { value: hours(r.workedMinutes), format: '0.00' } : null,
        r.late ? 'Sí' : '',
        r.lateMinutes,
        r.checkInCodeExpired ? 'Sí' : '',
        r.overtime?.authorizedMinutes != null
          ? { value: hours(r.overtime.authorizedMinutes), format: '0.00' }
          : null,
        r.overtime?.unauthorizedMinutes != null
          ? { value: hours(r.overtime.unauthorizedMinutes), format: '0.00' }
          : null,
        STATUS_LABEL[r.status],
        r.checkOutKind ? KIND_LABEL[r.checkOutKind] : '',
        r.checkOutKind === 'early' ? (r.checkOutReason ?? '') : '',
        SOURCE_LABEL[r.checkInSource],
        r.checkOutSource ? SOURCE_LABEL[r.checkOutSource] : '',
        comments.join(' · '),
        r.reviewReasons.map((x) => REVIEW_LABEL[x] ?? x).join(', '),
        row.justifications,
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
      'Retardos',
      'Horas extra autorizadas',
      'Tiempo no autorizado (horas)',
      'Domingos trabajados',
      'Descansos trabajados',
      'Festivos trabajados',
      'Id de usuario',
    ].map(bold);
    const groups = new Map<
      string,
      { siteName: string; name: string; userId: string; recs: AttendanceRecord[]; days: DayInfo[] }
    >();
    for (const row of rows) {
      const key = `${row.siteName}\u0000${row.record.userId}`;
      const g = groups.get(key) ?? {
        siteName: row.siteName,
        name: row.name,
        userId: row.record.userId,
        recs: [],
        days: [],
      };
      g.recs.push(row.record);
      g.days.push(row.day);
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
        g.recs.filter((r) => r.late).length,
        {
          value: hours(g.recs.reduce((s, r) => s + (r.overtime?.authorizedMinutes ?? 0), 0)),
          format: '0.00',
        },
        {
          value: hours(g.recs.reduce((s, r) => s + (r.overtime?.unauthorizedMinutes ?? 0), 0)),
          format: '0.00',
        },
        g.days.filter((d) => d.sunday).length,
        g.days.filter((d) => d.dayType === 'rest').length,
        g.days.filter((d) => d.dayType === 'holiday').length,
        g.userId,
      ]);
    }
    return data;
  }
}

const DETAIL_WIDTHS = [
  18, 28, 16, 28, 12, 22, 9, 17, 17, 8, 9, 14, 14, 12, 14, 16, 14, 30, 20, 20, 40, 30, 30, 28,
];
const SUMMARY_WIDTHS = [18, 28, 16, 10, 18, 18, 20, 26, 10, 14, 14, 12, 12, 12, 28];
