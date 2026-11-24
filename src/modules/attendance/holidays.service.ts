import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/prisma/client.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { fail, fromDate, siteOrFail, toDate } from './attendance.records.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import { mexicanStatutoryHolidays } from './rules/calendar.js';

type HolidayRow = NonNullable<Awaited<ReturnType<TransactionClient['holiday']['findFirst']>>>;

const toDto = (h: HolidayRow) => ({
  id: h.id,
  siteId: h.siteId,
  date: fromDate(h.date),
  name: h.name,
  source: h.source === 'statutory' ? ('statutory' as const) : ('custom' as const),
  createdBy: h.createdBy,
  createdAt: h.createdAt.toISOString(),
});

const yearRange = (year: number | undefined) =>
  year ? { gte: toDate(`${year}-01-01`), lte: toDate(`${year}-12-31`) } : undefined;

/**
 * Días festivos (regla 15): de la compañía (todas sus sedes) o de una sede. Los del artículo 74 de
 * la LFT se cargan con un solo llamado por año. Son configuración: se pueden borrar, con auditoría.
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private actor() {
    const actorId = this.cls.get('actor')?.userId;
    if (!actorId) throw new Error('Esta operación necesita una sesión');
    return actorId;
  }

  /** Los de la compañía y, en una ruta de sede, los que valen en ella (los de la compañía y los suyos). */
  list(year: number | undefined) {
    const siteId = this.cls.get('siteId');
    return this.db.run(async (tx, companyId) => ({
      items: (
        await tx.holiday.findMany({
          where: {
            companyId,
            ...(siteId ? { OR: [{ siteId: null }, { siteId }] } : {}),
            ...(year ? { date: yearRange(year) } : {}),
          },
          orderBy: [{ date: 'asc' }, { siteId: { sort: 'asc', nulls: 'first' } }],
        })
      ).map(toDto),
    }));
  }

  /** Agrega un festivo a la compañía, o a la sede de la ruta. */
  async create(date: string, name: string) {
    const siteId = this.cls.get('siteId') ?? null;
    const actorId = this.actor();
    try {
      return await this.db.run(async (tx, companyId) => {
        if (siteId) await siteOrFail(tx, companyId, siteId);
        const h = await tx.holiday.create({
          data: { companyId, siteId, date: toDate(date), name, source: 'custom', createdBy: actorId },
        });
        await this.audit.record(tx, companyId, {
          action: 'holiday.create',
          targetType: 'holiday',
          targetId: h.id,
          after: { siteId, date, name },
        });
        return toDto(h);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.holidayExists, `Ya hay un festivo el ${date}`);
      }
      throw e;
    }
  }

  /** Carga los festivos del artículo 74 de la LFT de un año para toda la compañía (los que falten). */
  statutory(year: number) {
    const actorId = this.actor();
    return this.db.run(async (tx, companyId) => {
      const wanted = mexicanStatutoryHolidays(year);
      const existing = await tx.holiday.findMany({
        where: { companyId, siteId: null, date: yearRange(year) },
      });
      const have = new Set(existing.map((h) => fromDate(h.date)));
      const missing = wanted.filter((h) => !have.has(h.date));
      if (missing.length) {
        await tx.holiday.createMany({
          data: missing.map((h) => ({
            companyId,
            siteId: null,
            date: toDate(h.date),
            name: h.name,
            source: 'statutory',
            createdBy: actorId,
          })),
        });
      }
      await this.audit.record(tx, companyId, {
        action: 'holiday.load-statutory',
        targetType: 'company',
        targetId: companyId,
        after: { year, added: missing.map((h) => h.date) },
      });
      const all = await tx.holiday.findMany({
        where: { companyId, siteId: null, date: yearRange(year) },
        orderBy: { date: 'asc' },
      });
      return { items: all.map(toDto) };
    });
  }

  remove(id: string) {
    return this.db.run(async (tx, companyId) => {
      const h = await tx.holiday.findFirst({ where: { id, companyId } });
      if (!h) fail(HttpStatus.NOT_FOUND, ATTENDANCE_ERRORS.holidayNotFound, 'No existe ese festivo');
      await tx.holiday.deleteMany({ where: { id, companyId } });
      await this.audit.record(tx, companyId, {
        action: 'holiday.delete',
        targetType: 'holiday',
        targetId: id,
        before: { siteId: h.siteId, date: fromDate(h.date), name: h.name, source: h.source },
      });
    });
  }
}
