import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Clock } from '../../common/clock.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { fail, fromDate, type RecordRow } from './attendance.records.js';
import { ATTENDANCE_ERRORS, type NoticeSchema } from './attendance.schemas.js';
import { type Person, PeopleDirectory } from './people.js';
import { pendingReview } from './rules/review.js';
import type { z } from 'zod';

type NoticeRow = NonNullable<Awaited<ReturnType<TransactionClient['notice']['findFirst']>>>;
type JustificationRow = NonNullable<Awaited<ReturnType<TransactionClient['justification']['findFirst']>>>;
type Notice = z.infer<typeof NoticeSchema>;

/** Días hacia atrás que muestra la lista con los avisos ya atendidos. */
const HISTORY_DAYS = 31;
const DAY = 86_400_000;
const MAX_ITEMS = 200;

const unknownPerson = (userId: string): Person => ({ userId, name: '', phoneNumber: null, email: null });

const asKind = (k: string): Notice['kind'] => (k === 'justification' ? 'justification' : 'attendance-review');

const toDto = (n: NoticeRow, person: Person): Notice => ({
  id: n.id,
  siteId: n.siteId,
  kind: asKind(n.kind),
  person,
  workDate: fromDate(n.workDate),
  attendanceRecordId: n.attendanceRecordId,
  justificationId: n.justificationId,
  detail: n.detail,
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
  readAt: n.readAt?.toISOString() ?? null,
  readBy: n.readBy,
});

type RecordForNotice = Pick<
  RecordRow,
  'id' | 'companyId' | 'siteId' | 'userId' | 'workDate' | 'reviewReasons' | 'reviewedReasons'
>;

/**
 * Avisos para los líderes de una sede (regla 8, ADR 0015). Se escriben dentro de la transacción del
 * evento que los causa (una entrada o salida por revisar, una justificación), así que no hay aviso
 * sin evento ni evento sin aviso. Son de la sede: cuando un líder atiende uno, deja de estar
 * pendiente para todos. Las notificaciones push (después del 1 de enero) saldrán de aquí.
 */
@Injectable()
export class NoticeService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly people: PeopleDirectory,
    private readonly cls: ClsService<RequestContext>,
    private readonly clock: Clock,
  ) {}

  /**
   * Deja el aviso de una jornada al día con lo que falta por revisar: lo crea, le pone los motivos
   * nuevos o, si ya no falta nada, lo da por atendido (con `actorId`). A lo más uno pendiente por
   * jornada (índice único parcial).
   */
  async syncRecord(tx: TransactionClient, r: RecordForNotice, now: Date, actorId: string | null) {
    const pending = pendingReview(r.reviewReasons, r.reviewedReasons);
    const open = await tx.notice.findFirst({
      where: { companyId: r.companyId, attendanceRecordId: r.id, kind: 'attendance-review', readAt: null },
    });
    if (pending.length === 0) {
      if (open && actorId) {
        await tx.notice.update({ where: { id: open.id }, data: { readAt: now, readBy: actorId } });
      }
      return;
    }
    if (open) {
      if (open.detail.join() !== pending.join()) {
        await tx.notice.update({ where: { id: open.id }, data: { detail: pending } });
      }
      return;
    }
    await tx.notice.create({
      data: {
        companyId: r.companyId,
        siteId: r.siteId,
        kind: 'attendance-review',
        userId: r.userId,
        workDate: r.workDate,
        attendanceRecordId: r.id,
        detail: pending,
        createdAt: now,
      },
    });
  }

  /** Aviso de una justificación nueva. */
  async justificationSubmitted(tx: TransactionClient, j: JustificationRow) {
    await tx.notice.create({
      data: {
        companyId: j.companyId,
        siteId: j.siteId,
        kind: 'justification',
        userId: j.userId,
        workDate: j.workDate,
        attendanceRecordId: j.attendanceRecordId,
        justificationId: j.id,
        detail: [j.kind],
        createdAt: j.submittedAt,
      },
    });
  }

  /** Al resolver una justificación, su aviso queda atendido. */
  async justificationResolved(
    tx: TransactionClient,
    companyId: string,
    justificationId: string,
    now: Date,
    actorId: string,
  ) {
    await tx.notice.updateMany({
      where: { companyId, justificationId, readAt: null },
      data: { readAt: now, readBy: actorId },
    });
  }

  private context() {
    const siteId = this.cls.get('siteId');
    const actorId = this.cls.get('actor')?.userId;
    if (!siteId || !actorId) throw new Error('Esta operación necesita una ruta de sede y una sesión');
    return { siteId, actorId };
  }

  /** Avisos de la sede: los pendientes, o también los atendidos del último mes. */
  async list(status: 'open' | 'all') {
    const { siteId } = this.context();
    const since = new Date(this.clock.now().getTime() - HISTORY_DAYS * DAY);
    const { rows, open } = await this.db.run(async (tx, companyId) => {
      const [found, pending] = await Promise.all([
        tx.notice.findMany({
          where: {
            companyId,
            siteId,
            ...(status === 'open'
              ? { readAt: null }
              : { OR: [{ readAt: null }, { updatedAt: { gte: since } }] }),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: MAX_ITEMS,
        }),
        tx.notice.count({ where: { companyId, siteId, readAt: null } }),
      ]);
      return { rows: found, open: pending };
    });
    const people = await this.people.people(rows.map((n) => n.userId));
    return { open, items: rows.map((n) => toDto(n, people.get(n.userId) ?? unknownPerson(n.userId))) };
  }

  /**
   * Da un aviso por atendido a mano ("ya lo vi"). No revisa la jornada ni resuelve la justificación:
   * esas siguen en sus listas. Idempotente: uno ya atendido se devuelve tal cual.
   */
  async markRead(id: string) {
    const { siteId, actorId } = this.context();
    const now = this.clock.now();
    const n = await this.db.run(async (tx, companyId) => {
      const row = await tx.notice.findFirst({ where: { id, companyId, siteId } });
      if (!row) fail(HttpStatus.NOT_FOUND, ATTENDANCE_ERRORS.noticeNotFound, 'No existe ese aviso');
      if (row.readAt) return row;
      const data = { readAt: now, readBy: actorId };
      const updated = await tx.notice.updateMany({ where: { id, companyId, readAt: null }, data });
      if (updated.count === 0) return (await tx.notice.findFirst({ where: { id, companyId } }))!;
      await this.audit.record(tx, companyId, {
        action: 'notice.read',
        targetType: 'notice',
        targetId: id,
        after: { siteId, kind: row.kind, userId: row.userId, workDate: fromDate(row.workDate) },
      });
      return { ...row, ...data };
    });
    const people = await this.people.people([n.userId]);
    return toDto(n, people.get(n.userId) ?? unknownPerson(n.userId));
  }
}
