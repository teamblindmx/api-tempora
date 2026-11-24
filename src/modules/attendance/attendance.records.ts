import { HttpException, HttpStatus } from '@nestjs/common';
import type { TransactionClient } from '../../database/prisma-client.js';
import {
  ATTENDANCE_ERRORS,
  type AttendanceRecord,
  type Overtime,
  type OvertimeAuthorization,
} from './attendance.schemas.js';
import { recordStatus } from './rules/marking.js';
import { authorizedEnd, overtimeMinutes } from './rules/overtime.js';
import { workedMinutes } from './rules/panel.js';
import { scheduledEnd, type Shift } from './rules/workday.js';

/** Piezas comunes del marcado, el panel y la exportación. */

export type SiteRow = NonNullable<Awaited<ReturnType<TransactionClient['site']['findFirst']>>>;
export type RecordRow = NonNullable<Awaited<ReturnType<TransactionClient['attendanceRecord']['findFirst']>>>;
export type OvertimeRow = NonNullable<
  Awaited<ReturnType<TransactionClient['overtimeAuthorization']['findFirst']>>
>;

/** Error de negocio: estado HTTP, código estable y mensaje en español para la persona. */
export function fail(status: HttpStatus, code: string, message: string): never {
  throw new HttpException({ statusCode: status, code, message }, status);
}

/** "YYYY-MM-DD" a la fecha que guarda la columna DATE, y de vuelta. */
export const toDate = (workDate: string) => new Date(`${workDate}T00:00:00Z`);
export const fromDate = (d: Date) => d.toISOString().slice(0, 10);

export const shiftOf = (site: SiteRow): Shift | null =>
  site.shiftStart && site.shiftEnd ? { start: site.shiftStart, end: site.shiftEnd } : null;

export const siteCoords = (site: SiteRow) => ({
  latitude: site.latitude.toNumber(),
  longitude: site.longitude.toNumber(),
  radiusM: site.radiusM,
});

/** La sede de Tempora (ubicación y horario) o 409 si aún no se configura. */
export async function siteOrFail(tx: TransactionClient, companyId: string, siteId: string) {
  const site = await tx.site.findFirst({ where: { id: siteId, companyId } });
  if (!site) {
    fail(
      HttpStatus.CONFLICT,
      ATTENDANCE_ERRORS.siteNotConfigured,
      'La sede aún no tiene ubicación configurada',
    );
  }
  return site;
}

export type RecordView = Pick<
  RecordRow,
  | 'id'
  | 'siteId'
  | 'userId'
  | 'workDate'
  | 'checkInAt'
  | 'checkInDistanceM'
  | 'checkInSource'
  | 'checkInBy'
  | 'checkInComment'
  | 'checkInLate'
  | 'checkInLateMinutes'
  | 'checkInCodeExpired'
  | 'checkOutAt'
  | 'checkOutDistanceM'
  | 'checkOutKind'
  | 'checkOutReason'
  | 'checkOutSource'
  | 'checkOutBy'
  | 'checkOutComment'
  | 'reviewReasons'
>;

const source = (s: string | null) => (s === 'self' || s === 'manual' ? s : null);

/** Lo que hace falta para calcular las horas extra de una jornada. Sin esto, `overtime` es null. */
export interface OvertimeContext {
  timezone: string;
  now: Date;
  authorization: OvertimeRow | null;
}

export function toRecordDto(
  r: RecordView,
  today: string,
  shift: Shift | null,
  ot?: OvertimeContext,
): AttendanceRecord {
  const workDate = fromDate(r.workDate);
  const status = recordStatus({ workDate, checkOutAt: r.checkOutAt }, today, shift);
  return {
    id: r.id,
    siteId: r.siteId,
    userId: r.userId,
    workDate,
    status,
    checkInAt: r.checkInAt.toISOString(),
    checkInDistanceM: r.checkInDistanceM,
    checkInSource: source(r.checkInSource) ?? 'self',
    checkInBy: r.checkInBy,
    checkInComment: r.checkInComment,
    late: r.checkInLate,
    lateMinutes: r.checkInLateMinutes,
    checkInCodeExpired: r.checkInCodeExpired,
    checkOutAt: r.checkOutAt?.toISOString() ?? null,
    checkOutDistanceM: r.checkOutDistanceM,
    checkOutKind: r.checkOutKind === 'regular' || r.checkOutKind === 'early' ? r.checkOutKind : null,
    checkOutReason: r.checkOutReason,
    checkOutSource: source(r.checkOutSource),
    checkOutBy: r.checkOutBy,
    checkOutComment: r.checkOutComment,
    workedMinutes: workedMinutes(r.checkInAt, r.checkOutAt),
    needsReview: r.reviewReasons.length > 0,
    reviewReasons: r.reviewReasons,
    overtime:
      shift && ot ? overtimeOf(workDate, shift, ot, r.checkOutAt, status === 'open' && !r.checkOutAt) : null,
  };
}

export function toOvertimeAuthDto(a: OvertimeRow): OvertimeAuthorization {
  return {
    id: a.id,
    siteId: a.siteId,
    userId: a.userId,
    workDate: fromDate(a.workDate),
    until: a.until?.toISOString() ?? null,
    effectiveUntil: authorizedEnd(a)?.toISOString() ?? null,
    reason: a.reason,
    authorizedBy: a.authorizedBy,
    authorizedAt: a.authorizedAt.toISOString(),
    closedBy: a.closedBy,
    closedAt: a.closedAt?.toISOString() ?? null,
  };
}

/**
 * Horas extra de una jornada (regla 9). Abierta: se cuentan hasta ahora. Sin salida de un día
 * anterior (salida pendiente): no se sabe cuántas, van en null.
 */
function overtimeOf(
  workDate: string,
  shift: Shift,
  ot: OvertimeContext,
  checkOutAt: Date | null,
  inProgress: boolean,
): Overtime {
  const end = scheduledEnd(workDate, shift, ot.timezone);
  const exitAt = checkOutAt ?? (inProgress ? ot.now : null);
  const minutes = exitAt ? overtimeMinutes(end, exitAt, ot.authorization) : null;
  return {
    scheduledEnd: end.toISOString(),
    inProgress,
    extraMinutes: minutes?.extraMinutes ?? null,
    authorizedMinutes: minutes?.authorizedMinutes ?? null,
    unauthorizedMinutes: minutes?.unauthorizedMinutes ?? null,
    authorization: ot.authorization ? toOvertimeAuthDto(ot.authorization) : null,
  };
}

/** Llave de una autorización o jornada por persona y día. */
export const dayKey = (userId: string, workDate: Date | string) =>
  `${userId}|${typeof workDate === 'string' ? workDate : fromDate(workDate)}`;

/** Autorizaciones de horas extra de un rango, por persona y día. */
export async function overtimeByDay(
  tx: TransactionClient,
  companyId: string,
  where: { siteId?: string; userId?: string; siteIds?: string[] },
  from: string,
  to: string,
): Promise<Map<string, OvertimeRow>> {
  const rows = await tx.overtimeAuthorization.findMany({
    where: {
      companyId,
      ...(where.siteId ? { siteId: where.siteId } : {}),
      ...(where.siteIds ? { siteId: { in: where.siteIds } } : {}),
      ...(where.userId ? { userId: where.userId } : {}),
      workDate: { gte: toDate(from), lte: toDate(to) },
    },
  });
  return new Map(rows.map((a) => [dayKey(a.userId, a.workDate), a]));
}

/** ¿Alguna parte de la jornada la registró el líder? */
export const isManual = (r: Pick<RecordRow, 'checkInSource' | 'checkOutSource'>) =>
  r.checkInSource === 'manual' || r.checkOutSource === 'manual';
