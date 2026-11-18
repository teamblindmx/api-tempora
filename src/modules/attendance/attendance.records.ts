import { HttpException, HttpStatus } from '@nestjs/common';
import type { TransactionClient } from '../../database/prisma-client.js';
import { ATTENDANCE_ERRORS, type AttendanceRecord } from './attendance.schemas.js';
import { recordStatus } from './rules/marking.js';
import { workedMinutes } from './rules/panel.js';
import type { Shift } from './rules/workday.js';

/** Piezas comunes del marcado, el panel y la exportación. */

export type SiteRow = NonNullable<Awaited<ReturnType<TransactionClient['site']['findFirst']>>>;
export type RecordRow = NonNullable<Awaited<ReturnType<TransactionClient['attendanceRecord']['findFirst']>>>;

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

export function toRecordDto(r: RecordView, today: string, shift: Shift | null): AttendanceRecord {
  const workDate = fromDate(r.workDate);
  return {
    id: r.id,
    siteId: r.siteId,
    userId: r.userId,
    workDate,
    status: recordStatus({ workDate, checkOutAt: r.checkOutAt }, today, shift),
    checkInAt: r.checkInAt.toISOString(),
    checkInDistanceM: r.checkInDistanceM,
    checkInSource: source(r.checkInSource) ?? 'self',
    checkInBy: r.checkInBy,
    checkInComment: r.checkInComment,
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
  };
}

/** ¿Alguna parte de la jornada la registró el líder? */
export const isManual = (r: Pick<RecordRow, 'checkInSource' | 'checkOutSource'>) =>
  r.checkInSource === 'manual' || r.checkOutSource === 'manual';
