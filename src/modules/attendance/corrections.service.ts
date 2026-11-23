import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Clock } from '../../common/clock.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import {
  fail,
  fromDate,
  type RecordRow,
  shiftOf,
  siteOrFail,
  toDate,
  toRecordDto,
} from './attendance.records.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import { NoticeService } from './notices.service.js';
import { type Person, PeopleDirectory } from './people.js';
import { CORRECTION_MAX_DAYS_BACK, type CorrectionProblem, planCorrection } from './rules/correction.js';
import { EXIT_REVIEW_THRESHOLD_MIN, exitKind, exitNeedsReview } from './rules/exit.js';
import { evaluateLateness } from './rules/lateness.js';
import { MAX_WORKDAY_HOURS } from './rules/manual.js';
import { overtimeMinutes } from './rules/overtime.js';
import { pendingReview, withOffSchedule } from './rules/review.js';
import { addDays, localDate, scheduledEnd } from './rules/workday.js';
import { dayOf } from './work-calendar.js';

const PROBLEM_MESSAGES: Record<CorrectionProblem, string> = {
  'nothing-to-change': 'Las horas que mandaste son las mismas que ya tiene',
  'no-exit': 'Esa jornada aún no tiene salida: regístrala con el marcado manual',
  'too-old': `Solo se corrigen jornadas de los últimos ${CORRECTION_MAX_DAYS_BACK} días`,
  future: 'La hora no puede ser en el futuro',
  'other-day': 'La entrada corregida debe quedar en el mismo día de la jornada',
  'before-check-in': 'La salida no puede quedar antes de la entrada',
  'too-long': `Una jornada no puede durar más de ${MAX_WORKDAY_HOURS} horas`,
};

const unknownPerson = (userId: string): Person => ({ userId, name: '', phoneNumber: null, email: null });

type CorrectionRow = NonNullable<Awaited<ReturnType<TransactionClient['attendanceCorrection']['findFirst']>>>;

const toCorrectionDto = (c: CorrectionRow) => ({
  id: c.id,
  correctedBy: c.correctedBy,
  correctedAt: c.correctedAt.toISOString(),
  checkInBefore: c.checkInBefore.toISOString(),
  checkInAfter: c.checkInAfter.toISOString(),
  checkOutBefore: c.checkOutBefore?.toISOString() ?? null,
  checkOutAfter: c.checkOutAfter?.toISOString() ?? null,
  comment: c.comment,
});

/** Lo que cambia de una jornada al corregirla o revisarla, para la auditoría. */
const snapshot = (r: RecordRow) => ({
  checkInAt: r.checkInAt.toISOString(),
  checkOutAt: r.checkOutAt?.toISOString() ?? null,
  late: r.checkInLate,
  lateMinutes: r.checkInLateMinutes,
  checkOutKind: r.checkOutKind,
  reviewReasons: r.reviewReasons,
  reviewedReasons: r.reviewedReasons,
});

/**
 * Lo que el líder hace sobre jornadas ya registradas (semana 7, ADR 0015): corregir horas, revisar
 * lo que quedó "por revisar" y ver el detalle con el historial. Igual que el resto de la jornada:
 * una transacción con la compañía de la petición (RLS), filtrando además por compañía y sede, con
 * auditoría y avisos en la misma transacción.
 */
@Injectable()
export class CorrectionService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly notices: NoticeService,
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

  private async recordOrFail(tx: TransactionClient, companyId: string, siteId: string, id: string) {
    const r = await tx.attendanceRecord.findFirst({ where: { id, companyId, siteId } });
    if (!r)
      fail(HttpStatus.NOT_FOUND, ATTENDANCE_ERRORS.recordNotFound, 'No existe esa jornada en esta sede');
    return r;
  }

  private changed(): never {
    fail(
      HttpStatus.CONFLICT,
      ATTENDANCE_ERRORS.recordChanged,
      'La jornada cambió mientras la editabas. Vuelve a cargarla.',
    );
  }

  /**
   * Corrige la hora de entrada o de salida (regla 13). Con la hora nueva se vuelve a decidir el
   * retardo (con el horario y la tolerancia actuales de la sede), el tipo de salida y si la salida
   * queda fuera de horario (regla 8). Los motivos de ubicación no cambian.
   */
  async correct(id: string, input: { checkInAt: string | null; checkOutAt: string | null; comment: string }) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const r = await this.recordOrFail(tx, companyId, siteId, id);
      if (r.userId === actorId) {
        fail(
          HttpStatus.FORBIDDEN,
          ATTENDANCE_ERRORS.correctionSelf,
          'No puedes corregir tu propia jornada: pídeselo a otro líder o a un administrador',
        );
      }
      const today = localDate(now, site.timezone);
      const workDate = fromDate(r.workDate);
      const newIn = input.checkInAt ? new Date(input.checkInAt) : null;
      const newOut = input.checkOutAt ? new Date(input.checkOutAt) : null;
      const plan = planCorrection({
        record: { workDate, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt },
        checkInAt: newIn,
        checkOutAt: newOut,
        checkInDate: newIn ? localDate(newIn, site.timezone) : null,
        now,
        today,
      });
      if (!plan.ok) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.correctionInvalid,
          PROBLEM_MESSAGES[plan.problem],
        );
      }

      const shift = shiftOf(site);
      const authorization = await tx.overtimeAuthorization.findFirst({
        where: { companyId, userId: r.userId, workDate: r.workDate },
      });
      const data: Partial<RecordRow> & { checkInAt: Date; checkOutAt: Date | null } = {
        checkInAt: plan.checkInAt,
        checkOutAt: plan.checkOutAt,
        correctedAt: now,
        correctedBy: actorId,
      };
      if (plan.checkInChanged) {
        const info = await dayOf(tx, companyId, site, workDate);
        const lateness = evaluateLateness({
          checkInAt: plan.checkInAt,
          workDate,
          shift,
          timeZone: site.timezone,
          toleranceMin: site.lateToleranceMin,
          workday: info.workday,
          codeExpired: r.checkInCodeExpired,
        });
        data.checkInLate = lateness.late;
        data.checkInLateMinutes = lateness.minutesAfterStart;
      }
      if (plan.checkOutChanged && plan.checkOutAt && shift) {
        const end = scheduledEnd(workDate, shift, site.timezone);
        const out = plan.checkOutAt;
        const kind = exitKind(out, end);
        // Regla 8, igual que en la salida: las horas extra autorizadas no mandan a revisión.
        const authorized =
          !!authorization &&
          out > end &&
          overtimeMinutes(end, out, authorization).unauthorizedMinutes <= EXIT_REVIEW_THRESHOLD_MIN;
        Object.assign(
          data,
          withOffSchedule(r.reviewReasons, r.reviewedReasons, exitNeedsReview(out, end, authorized)),
        );
        data.checkOutKind = kind;
        // Regla 6: una salida anticipada lleva motivo; si no lo tenía, el comentario de la corrección.
        if (kind === 'early' && !r.checkOutReason) data.checkOutReason = input.comment;
      }

      // Las horas de antes en el where: si alguien más la cambió entretanto, no se pisa.
      const updated = await tx.attendanceRecord.updateMany({
        where: { id, companyId, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt },
        data,
      });
      if (updated.count === 0) this.changed();
      const after: RecordRow = { ...r, ...data };
      await tx.attendanceCorrection.create({
        data: {
          companyId,
          siteId,
          attendanceRecordId: id,
          userId: r.userId,
          correctedBy: actorId,
          correctedAt: now,
          checkInBefore: r.checkInAt,
          checkInAfter: plan.checkInAt,
          checkOutBefore: r.checkOutAt,
          checkOutAfter: plan.checkOutAt,
          comment: input.comment,
        },
      });
      await this.audit.record(tx, companyId, {
        action: 'attendance.correct',
        targetType: 'attendance-record',
        targetId: id,
        before: snapshot(r),
        after: { ...snapshot(after), siteId, userId: r.userId, workDate },
        reason: input.comment,
      });
      await this.notices.syncRecord(tx, after, now, actorId);
      return toRecordDto(after, today, shift, { timezone: site.timezone, now, authorization });
    });
  }

  /**
   * Marca como revisados los motivos que tiene la jornada (reglas 3 y 8). Si después aparece uno
   * nuevo (por ejemplo, la salida fuera del radio), vuelve a quedar por revisar.
   */
  async review(id: string, comment: string | null) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const r = await this.recordOrFail(tx, companyId, siteId, id);
      if (r.userId === actorId) {
        fail(HttpStatus.FORBIDDEN, ATTENDANCE_ERRORS.reviewSelf, 'No puedes revisar tu propia jornada');
      }
      if (pendingReview(r.reviewReasons, r.reviewedReasons).length === 0) {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.nothingToReview, 'Esa jornada no tiene nada por revisar');
      }
      const data = {
        reviewedReasons: r.reviewReasons,
        reviewedAt: now,
        reviewedBy: actorId,
        reviewComment: comment,
      };
      const updated = await tx.attendanceRecord.updateMany({
        where: { id, companyId, reviewReasons: { equals: r.reviewReasons } },
        data,
      });
      if (updated.count === 0) this.changed();
      await this.audit.record(tx, companyId, {
        action: 'attendance.review',
        targetType: 'attendance-record',
        targetId: id,
        before: { reviewedReasons: r.reviewedReasons },
        after: { reviewedReasons: r.reviewReasons, siteId, userId: r.userId, workDate: fromDate(r.workDate) },
        ...(comment ? { reason: comment } : {}),
      });
      const after = { ...r, ...data };
      await this.notices.syncRecord(tx, after, now, actorId);
      const authorization = await tx.overtimeAuthorization.findFirst({
        where: { companyId, userId: r.userId, workDate: r.workDate },
      });
      return toRecordDto(after, localDate(now, site.timezone), shiftOf(site), {
        timezone: site.timezone,
        now,
        authorization,
      });
    });
  }

  /** Una jornada con la persona y su historial de correcciones. */
  async detail(id: string) {
    const { siteId } = this.context();
    const now = this.clock.now();
    const { record, corrections } = await this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const r = await this.recordOrFail(tx, companyId, siteId, id);
      const [authorization, history] = await Promise.all([
        tx.overtimeAuthorization.findFirst({ where: { companyId, userId: r.userId, workDate: r.workDate } }),
        tx.attendanceCorrection.findMany({
          where: { companyId, attendanceRecordId: id },
          orderBy: [{ correctedAt: 'asc' }, { id: 'asc' }],
        }),
      ]);
      return {
        record: toRecordDto(r, localDate(now, site.timezone), shiftOf(site), {
          timezone: site.timezone,
          now,
          authorization,
        }),
        corrections: history.map(toCorrectionDto),
      };
    });
    const people = await this.people.people([record.userId]);
    return { person: people.get(record.userId) ?? unknownPerson(record.userId), record, corrections };
  }

  /** Jornadas de la sede con algo sin revisar (por omisión, las del último mes). */
  async queue(q: { from?: string | undefined; to?: string | undefined }) {
    const { siteId } = this.context();
    const now = this.clock.now();
    const result = await this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const today = localDate(now, site.timezone);
      const to = q.to ?? today;
      const from = q.from ?? addDays(to, -CORRECTION_MAX_DAYS_BACK);
      if (from > to) {
        fail(HttpStatus.UNPROCESSABLE_ENTITY, ATTENDANCE_ERRORS.rangeInvalid, 'El rango está al revés');
      }
      const rows = (
        await tx.attendanceRecord.findMany({
          where: {
            companyId,
            siteId,
            workDate: { gte: toDate(from), lte: toDate(to) },
            reviewReasons: { isEmpty: false },
          },
          orderBy: [{ workDate: 'asc' }, { checkInAt: 'asc' }],
          take: 500,
        })
      ).filter((r) => pendingReview(r.reviewReasons, r.reviewedReasons).length > 0);
      const shift = shiftOf(site);
      return {
        from,
        to,
        rows: rows.map((r) => ({
          pendingReasons: pendingReview(r.reviewReasons, r.reviewedReasons),
          record: toRecordDto(r, today, shift),
        })),
      };
    });
    const people = await this.people.people(result.rows.map((r) => r.record.userId));
    return {
      siteId,
      from: result.from,
      to: result.to,
      items: result.rows.map((r) => ({
        person: people.get(r.record.userId) ?? unknownPerson(r.record.userId),
        ...r,
      })),
    };
  }
}
