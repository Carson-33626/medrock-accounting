import type { Entity } from './types';
import { monthEndIso, type Month } from './month';
import { getMonthlyProfitAndLoss } from '../quickbooks-multi';

export const EOM_ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

/** Per-company QB P&L total income for one month — the inputs to the presence test,
 *  kept so the End of Month tab can show WHY the split came out the way it did. */
export interface RevenueTest {
  month: string; // 'YYYY-MM'
  income: Record<Entity, number>;
}

/**
 * Barbara's presence rule (2026-07-27): every location with income > 0 gets an EQUAL
 * share — 3 with revenue -> 1/3 each, 2 -> 50/50, 1 -> 100%. Returns percent weights
 * summing to 100 (0 for the rest), or null when no location has revenue (caller
 * surfaces the error; no allocation is possible).
 */
export function sharesFromPresence(test: RevenueTest): Record<Entity, number> | null {
  const withRevenue = EOM_ENTITIES.filter((e) => test.income[e] > 0);
  if (withRevenue.length === 0) return null;
  const share = 100 / withRevenue.length;
  const out = {} as Record<Entity, number>;
  for (const e of EOM_ENTITIES) out[e] = withRevenue.includes(e) ? share : 0;
  return out;
}

/** One Accrual P&L call per company (books of record — deliberately NOT the Cash default
 *  used by location analytics). Throws if any company is disconnected or returns no data:
 *  a partial revenue test could silently mis-split. */
export async function fetchRevenuePresence(m: Month): Promise<RevenueTest> {
  const month = `${m.year}-${String(m.month).padStart(2, '0')}`;
  const startDate = `${month}-01`;
  const endDate = monthEndIso(m);
  const income = {} as Record<Entity, number>;
  for (const e of EOM_ENTITIES) {
    const rows = await getMonthlyProfitAndLoss({ location: e, startDate, endDate, accounting_method: 'Accrual' });
    const row = rows.find((r) => r.month === month);
    if (!row) throw new Error(`no P&L data for ${e} ${month}`);
    income[e] = row.revenue;
  }
  return { month, income };
}
