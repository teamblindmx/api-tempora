import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Clock } from '../../common/clock.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import {
  fail,
  fromDate,
  shiftOf,
  siteOrFail,
  toDate,
  toOvertimeAuthDto,
  toRecordDto,
} from './attendance.records.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import { type Person, PeopleDirectory } from './people.js';
import { authorizedEnd } from './rules/overtime.js';
import { addDays, localDate, scheduledEnd } from './rules/workday.js';

const unknownPerson = (userId: string): Person => ({ userId, name: '', phoneNumber: null, email: null });

/** Días hacia adelante que se puede autorizar antes (una semana). */
export const OVERTIME_MAX_DAYS_AHEAD = 7;

/**
 * Horas extra (regla 9): el líder las autoriza antes o en vivo, hasta una hora o como jornada
 * abierta que él cierra. No se autoriza después de la salida: eso ya no es "antes o en vivo", y el
 * tiempo trabajado de más queda como "no autorizado" para que nómina lo revise. Sin dobles ni
 * triples todavía (después del 1 de enero).
 */
@Injectable()
export class OvertimeService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly people: PeopleDirectory,
    private readonly cls: ClsService<RequestContext>,
    private readonly clock: Clock,
  ) {}

  private context() {
    const siteId = this.cls.get('siteId');
    const actorId = this.cls.get('actor')?.userId;
    if (!siteId || !actorId) throw new Error('Esta operación necesita una ruta de sede y una sesión');
    return { siteId, actorId };
  }

  /** Autoriza (o cambia la autorización de) un trabajador de la sede para un día. */
  async authorize(input: { userId: string; workDate: string | null; until: string | null; reason: string }) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    if (input.userId === actorId) {
      fail(
        HttpStatus.FORBIDDEN,
        ATTENDANCE_ERRORS.manualSelf,
        'No puedes autorizarte horas extra a ti mismo',
      );
    }
    const roster = await this.people.siteRoster(siteId, now);
    if (!roster.some((p) => p.userId === input.userId)) {
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ATTENDANCE_ERRORS.notSiteEmployee,
        'Esa persona no está asignada a esta sede',
      );
    }
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const shift = shiftOf(site);
      if (!shift) {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.shiftRequired,
          'La sede no tiene horario: sin hora de cierre no hay horas extra',
        );
      }
      const today = localDate(now, site.timezone);
      const workDate = input.workDate ?? today;
      // Antes (hasta una semana) o en vivo: hoy, o ayer si la jornada sigue abierta (turno de noche).
      if (workDate < addDays(today, -1) || workDate > addDays(today, OVERTIME_MAX_DAYS_AHEAD)) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.overtimeInvalid,
          `Las horas extra se autorizan para hoy o hasta ${OVERTIME_MAX_DAYS_AHEAD} días antes`,
        );
      }
      const end = scheduledEnd(workDate, shift, site.timezone);
      const until = input.until ? new Date(input.until) : null;
      if (until && (until <= end || until.getTime() - end.getTime() > 16 * 3_600_000)) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.overtimeInvalid,
          'La hora debe ser después del cierre del turno (y no más de 16 horas después)',
        );
      }
      const record = await tx.attendanceRecord.findFirst({
        where: { companyId, userId: input.userId, workDate: toDate(workDate) },
      });
      if (record?.checkOutAt) {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.overtimeAfterExit,
          'Esa jornada ya tiene salida: las horas extra se autorizan antes o en vivo',
        );
      }
      if (workDate < today && !record) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.overtimeInvalid,
          'Esa persona no tiene jornada ese día',
        );
      }
      if (record && record.siteId !== siteId) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.notSiteEmployee,
          'Esa jornada es de otra sede',
        );
      }

      const existing = await tx.overtimeAuthorization.findFirst({
        where: { companyId, userId: input.userId, workDate: toDate(workDate) },
      });
      if (existing?.closedAt) {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.overtimeClosed, 'Esa autorización ya se cerró');
      }
      if (existing && existing.siteId !== siteId) {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.overtimeClosed,
          'Esa persona ya tiene horas extra en otra sede ese día',
        );
      }
      const data = { until, reason: input.reason, authorizedBy: actorId, authorizedAt: now };
      const saved = existing
        ? await tx.overtimeAuthorization.update({ where: { id: existing.id }, data })
        : await tx.overtimeAuthorization.create({
            data: { companyId, siteId, userId: input.userId, workDate: toDate(workDate), ...data },
          });
      await this.audit.record(tx, companyId, {
        action: existing ? 'overtime.update' : 'overtime.authorize',
        targetType: 'overtime-authorization',
        targetId: saved.id,
        before: existing
          ? { until: existing.until?.toISOString() ?? null, authorizedBy: existing.authorizedBy }
          : undefined,
        after: { siteId, userId: input.userId, workDate, until: until?.toISOString() ?? null, open: !until },
        reason: input.reason,
      });
      return toOvertimeAuthDto(saved);
    });
  }

  /**
   * Cierra la autorización ahora: lo que el trabajador siga después es tiempo no autorizado. Es como
   * el líder cierra una "jornada abierta" (regla 9); también sirve para acortar una con hora.
   */
  close(id: string) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const auth = await tx.overtimeAuthorization.findFirst({ where: { id, companyId, siteId } });
      if (!auth) fail(HttpStatus.NOT_FOUND, ATTENDANCE_ERRORS.overtimeNotFound, 'No existe esa autorización');
      if (auth.userId === actorId) {
        fail(HttpStatus.FORBIDDEN, ATTENDANCE_ERRORS.manualSelf, 'No puedes cerrar tus propias horas extra');
      }
      if (auth.closedAt)
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.overtimeClosed, 'Esa autorización ya se cerró');
      const end = authorizedEnd(auth);
      if (end && end <= now) {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.overtimeClosed, 'Esa autorización ya terminó');
      }
      const updated = await tx.overtimeAuthorization.updateMany({
        where: { id, companyId, closedAt: null },
        data: { closedAt: now, closedBy: actorId },
      });
      if (updated.count === 0)
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.overtimeClosed, 'Esa autorización ya se cerró');
      await this.audit.record(tx, companyId, {
        action: 'overtime.close',
        targetType: 'overtime-authorization',
        targetId: id,
        before: { closedAt: null },
        after: { closedAt: now.toISOString(), userId: auth.userId, workDate: fromDate(auth.workDate) },
      });
      return toOvertimeAuthDto({ ...auth, closedAt: now, closedBy: actorId });
    });
  }

  /** Autorizaciones de un día en la sede, con la jornada y sus minutos si ya entró. */
  async list(date: string | undefined) {
    const { siteId } = this.context();
    const now = this.clock.now();
    const { day, rows } = await this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const today = localDate(now, site.timezone);
      const target = date ?? today;
      const auths = await tx.overtimeAuthorization.findMany({
        where: { companyId, siteId, workDate: toDate(target) },
        orderBy: { authorizedAt: 'asc' },
      });
      const records = await tx.attendanceRecord.findMany({
        where: { companyId, workDate: toDate(target), userId: { in: auths.map((a) => a.userId) } },
      });
      const shift = shiftOf(site);
      return {
        day: target,
        rows: auths.map((a) => {
          const r = records.find((x) => x.userId === a.userId);
          return {
            authorization: toOvertimeAuthDto(a),
            record: r
              ? toRecordDto(r, today, shift, { timezone: site.timezone, now, authorization: a })
              : null,
          };
        }),
      };
    });
    const people = await this.people.people(rows.map((r) => r.authorization.userId));
    return {
      siteId,
      date: day,
      items: rows.map((r) => ({
        person: people.get(r.authorization.userId) ?? unknownPerson(r.authorization.userId),
        ...r,
      })),
    };
  }
}
