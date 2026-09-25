/**
 * The month-end allocation a month would get if generated NOW: live pool, CS exclusion when
 * CS Allo already posted, revenue shares, drafts. One function so Generate and the daily
 * difference check can never disagree (DS 2026-09-25 §3.1). No gates, no writes.
 */
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue, type EomEntity, type RevenueTest } from './revenue-rule';
import { fetchAllocationPool, type PoolLine } from './qb-pool';
import { buildMonthEndAllocation } from './month-end';
import { listPostedCsAlloHeaders } from './eom-store';
import { excludeCsLines } from './cs-catchup';
import type { JournalDraft } from './types';
import type { Month } from './month';

export type EomTargetResult =
  | {
      ok: true;
      drafts: JournalDraft[];
      pool: PoolLine[];
      attention: PoolLine[];
      revenueTest: RevenueTest;
      shares: Record<EomEntity, number>;
      csAlloDocs: string[];
      csExcludedCount: number;
    }
  | { ok: false; status: 422 | 502; error: string };

export async function computeEomTarget(m: Month): Promise<EomTargetResult> {
  let revenueTest: RevenueTest;
  let pool: PoolLine[];
  let attention: PoolLine[];
  try {
    revenueTest = await fetchRevenuePresence(m);
    const r = await fetchAllocationPool(m);
    pool = r.pool;
    attention = r.attention;
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : 'Failed to fetch QuickBooks data' };
  }

  // HARD RULE (Carson, 2026-08-25): a month whose Customer Service was already allocated
  // by posted standalone CS Allo entries must NOT re-allocate it — the full month-end
  // covers everything else and its private note names the CS docs. Without this, running
  // the automation for April–August 2026 would move CS twice.
  const csHeaders = await listPostedCsAlloHeaders(m);
  const csAlloDocs = csHeaders.map((h) => h.qb_doc_number ?? `#${h.id}`);
  let csExcludedCount = 0;
  if (csHeaders.length > 0) {
    const { kept, cs } = excludeCsLines(pool);
    pool = kept;
    csExcludedCount = cs.length;
  }

  let shares = sharesFromRevenue(revenueTest);
  if (shares === null) {
    if (pool.some((l) => l.rule === 'revenue')) {
      return { ok: false, status: 422, error: `no location has revenue for ${m.year}-${String(m.month).padStart(2, '0')}` };
    }
    // thirds/fifty groups never read the shares record — an all-zero placeholder keeps
    // buildMonthEndAllocation's signature (Record<EomEntity, number>) satisfied.
    shares = Object.fromEntries(EOM_ENTITIES.map((e) => [e, 0])) as Record<EomEntity, number>;
  }

  const drafts = buildMonthEndAllocation(pool, shares, m, { csAlloDocs });
  return { ok: true, drafts, pool, attention, revenueTest, shares, csAlloDocs, csExcludedCount };
}
