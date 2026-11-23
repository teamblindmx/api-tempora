import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/prisma/client.js';
import { Clock } from '../../common/clock.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { fail, fromDate, siteOrFail, toDate } from './attendance.records.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import { type Person, PeopleDirectory } from './people.js';
import {
  asKind,
  asStatus,
  JUSTIFICATION_MAX_DAYS_BACK,
  type JustificationKind,
  justificationProblem,
  type JustificationProblem,
} from './rules/justification.js';
import { addDays, localDate } from './rules/workday.js';
import { dayOf } from './work-calendar.js';

type JustificationRow = NonNullable<Awaited<ReturnType<TransactionClient['justification']['findFirst']>>>;

const PROBLEM_MESSAGES: Record<JustificationProblem, string> = {
  future: 'Ese día todavía no termina',
  'too-old': `Solo se justifican los últimos ${JUSTIFICATION_MAX_DAYS_BACK} días`,
  'not-late': 'Esa entrada no quedó como retardo',
  'not-early-exit': 'Esa salida no fue anticipada',
  'has-record': 'Ese día sí tiene jornada: no es una falta',
  'no-record': 'No hay jornada en esta sede ese día',
  'not-workday': 'Ese día era de descanso o festivo',
};

const unknownPerson = (userId: string): Person => ({ userId, name: '', phoneNumber: null, email: null });

const toDto = (j: JustificationRow) => ({
  id: j.id,
  siteId: j.siteId,
  userId: j.userId,
  workDate: fromDate(j.workDate),
  kind: asKind(j.kind),
  attendanceRecordId: j.attendanceRecordId,
  reason: j.reason,
  submittedAt: j.submittedAt.toISOString(),
  status: asStatus(j.status),
  resolvedBy: j.resolvedBy,
  resolvedAt: j.resolvedAt?.toISOString() ?? null,
  resolutionComment: j.resolutionComment,
});

/**
 * Justificaciones (regla 12, versión simple): el trabajador escribe la suya y el líder de la sede la
 * aprueba o la rechaza. Una por día y tipo; el rechazo es final mientras no exista la disputa con
 * Recursos Humanos (después del 1 de enero). Nadie resuelve la suya.
 */
@Injectable()
export class JustificationService {
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

  async submit(input: { workDate: string; kind: JustificationKind; reason: string }) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    try {
      return await this.db.run(async (tx, companyId) => {
        const site = await siteOrFail(tx, companyId, siteId);
        const today = localDate(now, site.timezone);
        const record = await tx.attendanceRecord.findFirst({
          where: { companyId, userId: actorId, workDate: toDate(input.workDate) },
        });
        // Una jornada de otra sede no se justifica aquí.
        const here = record && record.siteId === siteId ? record : null;
        if (record && !here) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.justificationInvalid,
            'Esa jornada es de otra sede',
          );
        }
        const info = await dayOf(tx, companyId, site, input.workDate);
        const problem = justificationProblem({
          kind: input.kind,
          workDate: input.workDate,
          today,
          record: here ? { late: here.checkInLate, checkOutKind: here.checkOutKind } : null,
          workday: info.workday,
        });
        if (problem) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.justificationInvalid,
            PROBLEM_MESSAGES[problem],
          );
        }
        const j = await tx.justification.create({
          data: {
            companyId,
            siteId,
            userId: actorId,
            workDate: toDate(input.workDate),
            kind: input.kind,
            attendanceRecordId: input.kind === 'absence' ? null : here!.id,
            reason: input.reason,
            submittedBy: actorId,
            submittedAt: now,
          },
        });
        await this.audit.record(tx, companyId, {
          action: 'justification.submit',
          targetType: 'justification',
          targetId: j.id,
          after: { siteId, userId: actorId, workDate: input.workDate, kind: input.kind },
          reason: input.reason,
        });
        return toDto(j);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.justificationExists,
          'Ya enviaste una justificación de ese tipo para ese día',
        );
      }
      throw e;
    }
  }

  /** Las justificaciones propias en esta sede, de la más reciente a la más vieja. */
  mine() {
    const { siteId, actorId } = this.context();
    return this.db.run(async (tx, companyId) =>
      (
        await tx.justification.findMany({
          where: { companyId, siteId, userId: actorId },
          orderBy: [{ workDate: 'desc' }, { submittedAt: 'desc' }],
          take: 100,
        })
      ).map(toDto),
    );
  }

  /** Para el líder: las de la sede (por omisión, las del último mes), con la persona. */
  async list(q: {
    status?: 'pending' | 'approved' | 'rejected' | undefined;
    from?: string | undefined;
    to?: string | undefined;
  }) {
    const { siteId } = this.context();
    const now = this.clock.now();
    const rows = await this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const today = localDate(now, site.timezone);
      const to = q.to ?? today;
      const from = q.from ?? addDays(to, -JUSTIFICATION_MAX_DAYS_BACK);
      return tx.justification.findMany({
        where: {
          companyId,
          siteId,
          ...(q.status ? { status: q.status } : {}),
          workDate: { gte: toDate(from), lte: toDate(to) },
        },
        orderBy: [{ workDate: 'desc' }, { submittedAt: 'asc' }],
        take: 500,
      });
    });
    const people = await this.people.people(rows.map((r) => r.userId));
    return {
      items: rows.map((j) => ({ ...toDto(j), person: people.get(j.userId) ?? unknownPerson(j.userId) })),
    };
  }

  /** Aprueba o rechaza (con comentario obligatorio al rechazar). Solo una vez; nunca la propia. */
  resolve(id: string, decision: 'approved' | 'rejected', comment: string | null) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const j = await tx.justification.findFirst({ where: { id, companyId, siteId } });
      if (!j)
        fail(HttpStatus.NOT_FOUND, ATTENDANCE_ERRORS.justificationNotFound, 'No existe esa justificación');
      if (j.userId === actorId) {
        fail(
          HttpStatus.FORBIDDEN,
          ATTENDANCE_ERRORS.justificationSelf,
          'No puedes resolver tu propia justificación',
        );
      }
      const data = { status: decision, resolvedBy: actorId, resolvedAt: now, resolutionComment: comment };
      const updated = await tx.justification.updateMany({
        where: { id, companyId, status: 'pending' },
        data,
      });
      if (updated.count === 0) {
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.justificationResolved,
          'Esa justificación ya se resolvió',
        );
      }
      await this.audit.record(tx, companyId, {
        action: decision === 'approved' ? 'justification.approve' : 'justification.reject',
        targetType: 'justification',
        targetId: id,
        before: { status: 'pending' },
        after: { status: decision, userId: j.userId, workDate: fromDate(j.workDate), kind: j.kind },
        ...(comment ? { reason: comment } : {}),
      });
      return toDto({ ...j, ...data });
    });
  }
}
