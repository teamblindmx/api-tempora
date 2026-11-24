import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/prisma/client.js';
import { Clock } from '../../common/clock.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import {
  dayKey,
  fail,
  fromDate,
  isManual,
  type OvertimeRow,
  overtimeByDay,
  type RecordRow,
  shiftOf,
  siteOrFail,
  toDate,
  toRecordDto,
} from './attendance.records.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import { type Person, PeopleDirectory } from './people.js';
import { exitKind } from './rules/exit.js';
import { MANUAL_MAX_DAYS_BACK, manualCheckInProblem, manualCheckOutProblem } from './rules/manual.js';
import { recordStatus } from './rules/marking.js';
import { asKind, asStatus } from './rules/justification.js';
import { evaluateLateness } from './rules/lateness.js';
import { calendarStatus, type DayStatus, minutesAfterStart, monthDays, summarize } from './rules/panel.js';
import { addDays, localDate, scheduledEnd, type Shift } from './rules/workday.js';
import { dayOf, daysOf } from './work-calendar.js';

const STATUS_ORDER: Record<DayStatus, number> = { missing: 0, 'pending-exit': 1, open: 2, closed: 3 };

const MANUAL_TIME_MESSAGES = {
  future: 'La hora no puede ser en el futuro',
  'too-old': `Solo se registran a mano jornadas de los últimos ${MANUAL_MAX_DAYS_BACK} días`,
  'before-check-in': 'La salida no puede ser antes de la entrada',
  'too-long': 'Una jornada no puede durar más de 24 horas',
} as const;

const unknownPerson = (userId: string): Person => ({ userId, name: '', phoneNumber: null, email: null });

/**
 * Lo que hace el líder en su sede (semana 3): el panel del día, el marcado manual por un trabajador
 * y su calendario. Igual que el marcado propio: todo en una transacción con la compañía de la
 * petición (RLS), filtrando además por companyId y sede, y cada cambio con su auditoría.
 */
@Injectable()
export class LeaderService {
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

  /** Quién llegó y quién falta en la sede un día (hoy por defecto), y las salidas pendientes. */
  async day(date: string | undefined) {
    const { siteId } = this.context();
    const now = this.clock.now();
    const roster = await this.people.siteRoster(siteId, now);
    const { site, day, today, records, unclosed, info, auths } = await this.loadDay(siteId, date, now);
    const shift = shiftOf(site);
    const ot = (r: RecordRow) => ({
      timezone: site.timezone,
      now,
      authorization: auths.get(dayKey(r.userId, r.workDate)) ?? null,
    });
    const onRoster = new Set(roster.map((p) => p.userId));
    const others = await this.people.people(
      [...records, ...unclosed].map((r) => r.userId).filter((id) => !onRoster.has(id)),
    );
    const personOf = (userId: string) =>
      roster.find((p) => p.userId === userId) ?? others.get(userId) ?? unknownPerson(userId);
    const entry = (person: Person, r: RecordRow | undefined) => {
      const record = r ? toRecordDto(r, today, shift, ot(r)) : null;
      return {
        person,
        onRoster: onRoster.has(person.userId),
        status: record?.status ?? ('missing' as DayStatus),
        minutesAfterStart: r
          ? minutesAfterStart(r.checkInAt, fromDate(r.workDate), shift, site.timezone)
          : null,
        late: r?.checkInLate ?? false,
        manual: r ? isManual(r) : false,
        record,
      };
    };

    const byUser = new Map(records.map((r) => [r.userId, r]));
    const entries = [
      ...roster.map((p) => entry(p, byUser.get(p.userId))),
      ...records.filter((r) => !onRoster.has(r.userId)).map((r) => entry(personOf(r.userId), r)),
    ].toSorted(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.person.name.localeCompare(b.person.name, 'es') ||
        a.person.userId.localeCompare(b.person.userId),
    );
    return {
      siteId,
      date: day,
      today,
      timezone: site.timezone,
      shift,
      lateToleranceMin: site.lateToleranceMin,
      day: info,
      summary: {
        ...summarize(entries.map((e) => ({ ...e, needsReview: !!e.record?.needsReview }))),
        late: entries.filter((e) => e.late).length,
      },
      entries,
      pendingExits: unclosed
        .filter(
          (r) =>
            recordStatus({ workDate: fromDate(r.workDate), checkOutAt: null }, today, shift) ===
            'pending-exit',
        )
        .map((r) => entry(personOf(r.userId), r)),
    };
  }

  /** Jornadas del día en la sede y, si es hoy, las de días anteriores que siguen sin salida. */
  private loadDay(siteId: string, date: string | undefined, now: Date) {
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const today = localDate(now, site.timezone);
      const day = date ?? today;
      if (day > today) {
        fail(HttpStatus.UNPROCESSABLE_ENTITY, ATTENDANCE_ERRORS.dateInFuture, 'Ese día aún no llega');
      }
      const [records, unclosed] = await Promise.all([
        tx.attendanceRecord.findMany({ where: { companyId, siteId, workDate: toDate(day) } }),
        day === today
          ? tx.attendanceRecord.findMany({
              where: {
                companyId,
                siteId,
                checkOutAt: null,
                workDate: { lt: toDate(today), gte: toDate(addDays(today, -31)) },
              },
              orderBy: { workDate: 'desc' },
            })
          : Promise.resolve([] as RecordRow[]),
      ]);
      const from = unclosed.length ? fromDate(unclosed.at(-1)!.workDate) : day;
      const [info, auths] = await Promise.all([
        dayOf(tx, companyId, site, day),
        overtimeByDay(tx, companyId, { siteId }, from, day),
      ]);
      return { site, day, today, records, unclosed, info, auths };
    });
  }

  /** El líder no se marca a sí mismo, y solo marca a quien está asignado a su sede. */
  private async assertCanMarkFor(siteId: string, actorId: string, userId: string, now: Date) {
    if (userId === actorId) {
      fail(
        HttpStatus.FORBIDDEN,
        ATTENDANCE_ERRORS.manualSelf,
        'No puedes registrar tu propia asistencia a mano: márcala con el código',
      );
    }
    const roster = await this.people.siteRoster(siteId, now);
    if (!roster.some((p) => p.userId === userId)) {
      fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ATTENDANCE_ERRORS.notSiteEmployee,
        'Esa persona no está asignada a esta sede',
      );
    }
  }

  /**
   * Entrada registrada por el líder (sin código ni ubicación), con comentario obligatorio. La hora es
   * la del servidor, o la real de llegada si se registra después (hasta 7 días atrás).
   */
  async manualCheckIn(userId: string, comment: string, at: string | null) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    await this.assertCanMarkFor(siteId, actorId, userId, now);
    const when = at ? new Date(at) : now;
    try {
      return await this.db.run(async (tx, companyId) => {
        const site = await siteOrFail(tx, companyId, siteId);
        const today = localDate(now, site.timezone);
        const workDate = localDate(when, site.timezone);
        const problem = manualCheckInProblem({ at: when, now, workDate, today });
        if (problem) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.manualTimeInvalid,
            MANUAL_TIME_MESSAGES[problem],
          );
        }
        const existing = await tx.attendanceRecord.findFirst({
          where: { companyId, userId, workDate: toDate(workDate) },
        });
        if (existing) this.alreadyCheckedIn(workDate);

        const shift = shiftOf(site);
        const info = await dayOf(tx, companyId, site, workDate);
        const lateness = evaluateLateness({
          checkInAt: when,
          workDate,
          shift,
          timeZone: site.timezone,
          toleranceMin: site.lateToleranceMin,
          workday: info.workday,
          codeExpired: false,
        });
        const record = await tx.attendanceRecord.create({
          data: {
            companyId,
            siteId,
            userId,
            workDate: toDate(workDate),
            checkInAt: when,
            checkInSource: 'manual',
            checkInBy: actorId,
            checkInComment: comment,
            checkInLate: lateness.late,
            checkInLateMinutes: lateness.minutesAfterStart,
          },
        });
        await this.audit.record(tx, companyId, {
          action: 'attendance.manual-check-in',
          targetType: 'attendance-record',
          targetId: record.id,
          after: {
            siteId,
            userId,
            workDate,
            checkInAt: when.toISOString(),
            recordedAt: now.toISOString(),
            source: 'manual',
            late: lateness.late,
            lateMinutes: lateness.minutesAfterStart,
            dayType: info.dayType,
          },
          reason: comment,
        });
        return toRecordDto(record, today, shift);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        this.alreadyCheckedIn(null);
      }
      throw e;
    }
  }

  private alreadyCheckedIn(workDate: string | null): never {
    fail(
      HttpStatus.CONFLICT,
      ATTENDANCE_ERRORS.alreadyCheckedIn,
      `Esa persona ya tiene entrada ${workDate ? `el ${workDate}` : 'ese día'}`,
    );
  }

  /**
   * Salida registrada por el líder: cierra la jornada abierta del trabajador, o una salida
   * pendiente de otro día (regla 7). Para una salida pendiente hace falta la hora real.
   */
  async manualCheckOut(userId: string, comment: string, at: string | null, workDate: string | null) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    await this.assertCanMarkFor(siteId, actorId, userId, now);
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const shift = shiftOf(site);
      const today = localDate(now, site.timezone);
      const open = await tx.attendanceRecord.findFirst({
        where: {
          companyId,
          siteId,
          userId,
          checkOutAt: null,
          ...(workDate ? { workDate: toDate(workDate) } : { workDate: { lte: toDate(today) } }),
        },
        orderBy: { workDate: 'desc' },
      });
      if (!open) {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.notCheckedIn,
          workDate ? `No hay una jornada abierta el ${workDate}` : 'Esa persona no tiene una jornada abierta',
        );
      }
      const openDate = fromDate(open.workDate);
      const pending = recordStatus({ workDate: openDate, checkOutAt: null }, today, shift) === 'pending-exit';
      if (pending && !at) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.manualTimeRequired,
          `La jornada del ${openDate} quedó sin salida: indica la hora real en que salió`,
        );
      }
      const when = at ? new Date(at) : now;
      const problem = manualCheckOutProblem({ at: when, now, checkInAt: open.checkInAt });
      if (problem) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.manualTimeInvalid,
          MANUAL_TIME_MESSAGES[problem],
        );
      }

      const kind = this.kindOf(when, openDate, shift, site.timezone);
      const data = {
        checkOutAt: when,
        checkOutKind: kind,
        // Regla 6: una salida anticipada lleva motivo; en la manual, el comentario del líder.
        checkOutReason: kind === 'early' ? comment : null,
        checkOutSource: 'manual',
        checkOutBy: actorId,
        checkOutComment: comment,
      };
      const updated = await tx.attendanceRecord.updateMany({
        where: { id: open.id, companyId, checkOutAt: null },
        data,
      });
      if (updated.count === 0) {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.alreadyCheckedOut, 'Esa jornada ya tiene salida');
      }
      await this.audit.record(tx, companyId, {
        action: 'attendance.manual-check-out',
        targetType: 'attendance-record',
        targetId: open.id,
        before: { checkOutAt: null, status: pending ? 'pending-exit' : 'open' },
        after: {
          siteId,
          userId,
          workDate: openDate,
          checkOutAt: when.toISOString(),
          recordedAt: now.toISOString(),
          kind,
          source: 'manual',
        },
        reason: comment,
      });
      const authorization = await tx.overtimeAuthorization.findFirst({
        where: { companyId, userId, workDate: open.workDate },
      });
      return toRecordDto({ ...open, ...data }, today, shift, { timezone: site.timezone, now, authorization });
    });
  }

  private kindOf(when: Date, workDate: string, shift: Shift | null, timeZone: string) {
    return shift ? exitKind(when, scheduledEnd(workDate, shift, timeZone)) : 'regular';
  }

  /** Calendario de un mes de una persona en la sede (la propia, o la de un trabajador para el líder). */
  async calendar(userId: string | null, month: string | undefined) {
    const { siteId, actorId } = this.context();
    const who = userId ?? actorId;
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const shift = shiftOf(site);
      const today = localDate(now, site.timezone);
      const days = monthDays(month ?? today.slice(0, 7));
      const first = days[0]!;
      const last = days.at(-1)!;
      const [records, infos, auths, justifications] = await Promise.all([
        tx.attendanceRecord.findMany({
          where: { companyId, siteId, userId: who, workDate: { gte: toDate(first), lte: toDate(last) } },
        }),
        daysOf(tx, companyId, site, first, last),
        overtimeByDay(tx, companyId, { siteId, userId: who }, first, last),
        tx.justification.findMany({
          where: { companyId, siteId, userId: who, workDate: { gte: toDate(first), lte: toDate(last) } },
          orderBy: { submittedAt: 'asc' },
        }),
      ]);
      const authOf = (date: string): OvertimeRow | null => auths.get(dayKey(who, date)) ?? null;
      const byDate = new Map(
        records.map((r) => {
          const date = fromDate(r.workDate);
          return [
            date,
            toRecordDto(r, today, shift, { timezone: site.timezone, now, authorization: authOf(date) }),
          ];
        }),
      );
      const list = days.map((date) => {
        const record = byDate.get(date) ?? null;
        const info = infos.get(date)!;
        const base = calendarStatus(date, today, record?.status ?? null);
        return {
          date,
          status: base === 'no-record' && !info.workday ? ('day-off' as const) : base,
          ...info,
          record,
          justifications: justifications
            .filter((j) => fromDate(j.workDate) === date)
            .map((j) => ({
              id: j.id,
              kind: asKind(j.kind),
              status: asStatus(j.status),
            })),
        };
      });
      const recs = [...byDate.values()];
      const worked = (type: string) =>
        list.filter((d) => d.record && (type === 'sunday' ? d.sunday : d.dayType === type)).length;
      return {
        siteId,
        userId: who,
        month: first.slice(0, 7),
        today,
        days: list,
        totals: {
          daysWorked: recs.length,
          workedMinutes: recs.reduce((s, r) => s + (r.workedMinutes ?? 0), 0),
          pendingExits: recs.filter((r) => r.status === 'pending-exit').length,
          needsReview: recs.filter((r) => r.needsReview).length,
          manual: recs.filter((r) => r.checkInSource === 'manual' || r.checkOutSource === 'manual').length,
          noRecord: list.filter((d) => d.status === 'no-record').length,
          late: recs.filter((r) => r.late).length,
          sundaysWorked: worked('sunday'),
          restDaysWorked: worked('rest'),
          holidaysWorked: worked('holiday'),
          overtimeAuthorizedMinutes: recs.reduce((s, r) => s + (r.overtime?.authorizedMinutes ?? 0), 0),
          overtimeUnauthorizedMinutes: recs.reduce((s, r) => s + (r.overtime?.unauthorizedMinutes ?? 0), 0),
        },
      };
    });
  }
}
