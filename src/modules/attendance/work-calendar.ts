import type { TransactionClient } from '../../database/prisma-client.js';
import { fromDate, type SiteRow, toDate } from './attendance.records.js';
import { type DayInfo, dayInfo } from './rules/calendar.js';
import { addDays } from './rules/workday.js';

/**
 * Festivos y descansos de una sede en un rango: los festivos de la compañía (sin sede) y los de la
 * sede. Si los dos tienen la misma fecha, gana el nombre del de la sede.
 */
export async function holidaysOf(
  tx: TransactionClient,
  companyId: string,
  siteId: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const rows = await tx.holiday.findMany({
    where: {
      companyId,
      OR: [{ siteId: null }, { siteId }],
      date: { gte: toDate(from), lte: toDate(to) },
    },
    orderBy: { siteId: { sort: 'asc', nulls: 'first' } },
  });
  return new Map(rows.map((h) => [fromDate(h.date), h.name]));
}

/** Cómo es cada día del rango en la sede. */
export async function daysOf(
  tx: TransactionClient,
  companyId: string,
  site: Pick<SiteRow, 'id' | 'restDays'>,
  from: string,
  to: string,
): Promise<Map<string, DayInfo>> {
  const holidays = await holidaysOf(tx, companyId, site.id, from, to);
  const out = new Map<string, DayInfo>();
  for (let d = from; d <= to; d = addDays(d, 1))
    out.set(d, dayInfo(d, site.restDays, holidays.get(d) ?? null));
  return out;
}

/** Cómo es un día en la sede. */
export async function dayOf(
  tx: TransactionClient,
  companyId: string,
  site: Pick<SiteRow, 'id' | 'restDays'>,
  date: string,
): Promise<DayInfo> {
  return (await daysOf(tx, companyId, site, date, date)).get(date)!;
}
