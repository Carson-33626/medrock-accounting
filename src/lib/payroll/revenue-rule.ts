import type { Entity } from './types';
import { monthEndIso, type Month } from './month';
import { getMonthlyProfitAndLoss } from '../quickbooks-multi';

/** EOM stays trio-only (Barbara's rule only ever covered FL/TN/TX): every Record keyed by
 *  this type is genuinely populated for all its keys, unlike a bare `Record<Entity, …>`
 *  which would silently promise a 'FOCAS' entry EOM never fills in. */
export type EomEntity = Exclude<Entity, 'FOCAS'>;
export const EOM_ENTITIES: EomEntity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

/** Per-company QB P&L total income for one month — the inputs to the revenue split,
 *  kept so the End of Month tab can show WHY the split came out the way it did. */
export interface RevenueTest {
  month: string; // 'YYYY-MM'
  income: Record<EomEntity, number>;
}

/**
 * Amy's revenue rule: each location bears the shared pool in PROPORTION to its revenue —
 * `share[e] = income[e] / Σ income`. Returns percent weights summing to 100, or null when
 * no location has revenue (caller surfaces the error; no allocation is possible).
 *
 * Verified against Amy's own 2025 entries (`PR ALLO 2025.09`/`.10`, `FL-TN Rev Adj 2025.11`,
 * memo "Allocation of FL Admin expenses as % of Revenue"). October 2025: FL ended at
 * $34,646.95 of Administrative Wages against a $69,108.28 combined pool = 50.13%, versus a
 * 50.14% revenue share — and $34,647 is the figure on Amy's own budget-vs-actual report.
 * Note the shape of her entry: she pooled BOTH entities' wages and redistributed so each
 * one's FINAL cost equals its revenue share. That is this function applied to a pool that
 * contains every entity's shared labor, which is why the Allocate flag has to come from the
 * cost center rather than a hand-tagged roster (see mapping.resolveLine).
 *
 * Replaces `sharesFromPresence` (2026-08-24). That rule gave every location with income > 0
 * an EQUAL share, so it always returned 1/3 each and `Allocate - %` never actually split by
 * revenue — it kept the participation half of Amy's method and dropped the proportional
 * half. Negative income clamps to 0: a credit month reduces nobody's share below zero, and
 * an all-negative month returns null rather than inverting the split.
 */
export function sharesFromRevenue(test: RevenueTest): Record<EomEntity, number> | null {
  const positive = EOM_ENTITIES.map((e) => Math.max(0, test.income[e]));
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const out = {} as Record<EomEntity, number>;
  EOM_ENTITIES.forEach((e, i) => { out[e] = (positive[i] / total) * 100; });
  return out;
}

/** One Accrual P&L call per company (books of record — deliberately NOT the Cash default
 *  used by location analytics). Throws if any company is disconnected or returns no data:
 *  a partial revenue test could silently mis-split. */
export async function fetchRevenuePresence(m: Month): Promise<RevenueTest> {
  const month = `${m.year}-${String(m.month).padStart(2, '0')}`;
  const startDate = `${month}-01`;
  const endDate = monthEndIso(m);
  const income = {} as Record<EomEntity, number>;
  for (const e of EOM_ENTITIES) {
    const rows = await getMonthlyProfitAndLoss({ location: e, startDate, endDate, accounting_method: 'Accrual' });
    const row = rows.find((r) => r.month === month);
    if (!row) throw new Error(`no P&L data for ${e} ${month}`);
    income[e] = row.revenue;
  }
  return { month, income };
}
