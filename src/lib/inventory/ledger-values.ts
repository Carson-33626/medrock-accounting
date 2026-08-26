/**
 * The lot ledger read at (location, category) grain — the single definition of
 * "what was inventory worth," shared by the month-end close and the FIFO
 * valuation page.
 *
 * Both screens have to state the same figure for the same month, and the only
 * way to guarantee that is for both to come through here. Two queries that
 * merely *ought* to agree is how they drifted apart in the first place.
 *
 * WHY NOT `inventory.fifo_valuation_summary`: it agrees on the TOTAL to the cent
 * but disagrees per CATEGORY, because it folds opening-balance lots into the
 * product's real category while the close leaves them under 'Opening Balance'
 * (an OB lot has no QuickBooks sub-account to post to). Verified on 2026-03:
 * identical $7,014,971.32 totals, but Texas Compound Ingredient reads
 * $507,498.36 there against $135,659.08 here — the $372,771.50 of Texas opening
 * balance. That table also holds an accrual AND a cash row per cell, so any
 * query against it that omits `basis` silently doubles every figure.
 *
 * Server-only (pulls in `pg`).
 */
import type { Pool } from 'pg';
import type { CategoryLedgerValue } from './monthly-close';

/**
 * The category expression, written once. A lot with no `purchase_lots` row has
 * no coded category — it is opening-balance stock that predates our receipt
 * history — and must land in its own bucket rather than being dropped or folded
 * elsewhere, because the close posts it as a residual against the parent account.
 */
const CATEGORY_EXPR = `COALESCE(p.qb_category, 'Opening Balance')`;

/**
 * Collapsed pre-conversion lots (Florida's Pioneer era, mainly) are EXCLUDED
 * from valuation in every month — they are disclosed as their own bucket, never
 * summed into on-hand value. Without this filter they carried $33K–$745K of
 * transitional remaining_value in historical months (2023-07 → 2025-02), which
 * put two false spikes on the valuation page's trend chart. Close months carry
 * $0.00 flagged value, so the close was never affected — verified 2026-08-26.
 */
const NOT_COLLAPSED = `COALESCE(l.pre_floor_collapsed, false) = false`;

/** One month's cells, with the receipt ids the close needs to substantiate a line. */
export async function fetchCategoryLedgerValues(
  pool: Pool,
  month: string,
): Promise<CategoryLedgerValue[]> {
  const { rows } = await pool.query<{
    location: string;
    qb_category: string;
    ending_value: number;
    receipt_ids: string[];
    lot_count: number;
  }>(
    `SELECT l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value,
            array_agg(DISTINCT l.receipt_id) AS receipt_ids,
            count(*)::int AS lot_count
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1 AND ${NOT_COLLAPSED}
     GROUP BY l.location, ${CATEGORY_EXPR}
     ORDER BY l.location, qb_category`,
    [month],
  );
  return rows.map((r) => ({
    location: r.location,
    qbCategory: r.qb_category,
    endingValue: r.ending_value,
    receiptIds: r.receipt_ids,
    lotCount: r.lot_count,
  }));
}

export interface LedgerSeriesRow {
  month: string;
  location: string;
  qbCategory: string;
  value: number;
  lotCount: number;
}

/**
 * EVERY month's cells at the same grain, for the valuation page's month picker,
 * headline, breakdowns and trend chart.
 *
 * Deliberately without `receiptIds`: that is thousands of ids per cell and the
 * browser never needs them — the drill-down re-queries by filter instead. What
 * is left is roughly 15 cells a month, so the whole history is a few hundred
 * rows and the page can move between months without a round trip.
 */
export async function fetchCategoryLedgerSeries(pool: Pool): Promise<LedgerSeriesRow[]> {
  const { rows } = await pool.query<{
    as_of_month: string;
    location: string;
    qb_category: string;
    value: number;
    lot_count: number;
  }>(
    `SELECT l.as_of_month,
            l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.remaining_value), 0)::float8 AS value,
            count(*)::int AS lot_count
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE ${NOT_COLLAPSED}
     GROUP BY l.as_of_month, l.location, ${CATEGORY_EXPR}
     ORDER BY l.as_of_month, l.location, qb_category`,
  );
  return rows.map((r) => ({
    month: r.as_of_month,
    location: r.location,
    qbCategory: r.qb_category,
    value: r.value,
    lotCount: r.lot_count,
  }));
}
