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
import type { CategoryCogsSeriesRow, CategoryLedgerMovementRow } from '@/types/inventory';
import { PRODUCT_NAMES_CTE, RESOLVED_PRODUCT_NAME } from '@/lib/inventory-sql';

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

/**
 * Purchases: lots whose receipt date falls IN this month. A lot received in March
 * first appears in the March ledger, so summing its `total_cost` here is the same
 * population the ending value is drawn from — not a second, independently-drifting
 * cut of the receipts table.
 *
 * Parameterised on the month EXPRESSION rather than a literal placeholder: the
 * one-month read compares against the bound `$1`, the whole-history series against
 * the row's own `l.as_of_month`. Same predicate either way, written once.
 */
const purchasesExpr = (monthRef: string): string =>
  `sum(CASE WHEN to_char(p.date_received, 'YYYY-MM') = ${monthRef} THEN p.total_cost ELSE 0 END)`;

/**
 * Value consumed in the month, from the ledger's own `qty_consumed`.
 *
 * `qty_consumed` is PER-MONTH, not cumulative — measured 2026-09-03 against the
 * loader, which accumulates `slot.consumedValueInMonth += consumed × unitCost` from
 * `receipt.consumedByMonth.get(month)` (transforms/fifo/valuation.ts). Taking a
 * month-over-month delta of it, as a cumulative reading would, understates COGS by
 * exactly the prior month's figure.
 *
 * Reproduces `fifo_valuation_summary.consumed_value_in_month` to the cent for every
 * Tennessee and Texas cell in 2026-03, -06 and -07. It reads $0 for opening-balance
 * lots, which carry no `unit_cost` — see `cogsValue` below for how that is handled.
 */
const CONSUMED_EXPR = `sum(l.qty_consumed * COALESCE(p.unit_cost, 0))`;

/** One month's cells, with the receipt ids the close needs to substantiate a line. */
export async function fetchCategoryLedgerValues(
  pool: Pool,
  month: string,
): Promise<CategoryLedgerValue[]> {
  const { rows } = await pool.query<{
    location: string;
    qb_category: string;
    ending_value: number;
    purchases_value: number;
    consumed_value: number;
    receipt_ids: string[];
    lot_count: number;
  }>(
    `SELECT l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value,
            COALESCE(${purchasesExpr('$1')}, 0)::float8 AS purchases_value,
            COALESCE(${CONSUMED_EXPR}, 0)::float8 AS consumed_value,
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
    purchasesValue: r.purchases_value,
    consumedValue: r.consumed_value,
    receiptIds: r.receipt_ids,
    lotCount: r.lot_count,
  }));
}

/**
 * COGS by category by month — the QuickBooks 5000.xx P&L shape, from our side.
 *
 * Carson, 2026-09-03, from a QB P&L showing 5000.05/.10/.15/.20/.35 populated for
 * January and February 2026 and BLANK from March on: the close JEs have never
 * posted, so $1.5M of category COGS is simply missing from the books. This is the
 * view that makes that visible.
 *
 * Same `qty_consumed x unit_cost` basis as `fetchCategoryLedgerValues`, so a column
 * of this grid and that month's roll-forward are the same number.
 */
export async function fetchCategoryCogsSeries(
  pool: Pool,
  fromMonth = '0000-00',
  toMonth = '9999-99',
): Promise<CategoryCogsSeriesRow[]> {
  const { rows } = await pool.query<{
    as_of_month: string;
    location: string;
    qb_category: string;
    cogs: number;
  }>(
    `SELECT l.as_of_month,
            l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.qty_consumed * COALESCE(p.unit_cost, 0)), 0)::float8 AS cogs
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE ${NOT_COLLAPSED} AND l.as_of_month BETWEEN $1 AND $2
     GROUP BY l.as_of_month, l.location, ${CATEGORY_EXPR}
     ORDER BY l.as_of_month, l.location, qb_category`,
    [fromMonth, toMonth],
  );
  return rows.map((r) => ({
    month: r.as_of_month,
    location: r.location,
    qbCategory: r.qb_category,
    cogs: r.cogs,
  }));
}

/**
 * EVERY month's ending value, purchases and consumption at (location, category)
 * grain — the whole roll-forward history in one query.
 *
 * This is `fetchCategoryLedgerValues` without the single-month bind and without
 * the receipt ids: the COGS tab reads two months at a time and the month picker is
 * meant to move freely, so the browser holds the series and re-cuts it rather than
 * fetching a month per step. The receipt ids stay out for the same reason they do
 * in `fetchCategoryLedgerSeries` — thousands per cell that no screen reads.
 *
 * Kept separate from `fetchCategoryLedgerSeries` (which carries `lotCount` for the
 * valuation page and nothing else) rather than folded into it: the two routes want
 * different columns, and every expression they share is defined once above, so
 * they cannot drift on the arithmetic that matters.
 */
export async function fetchCategoryLedgerMovementSeries(
  pool: Pool,
): Promise<CategoryLedgerMovementRow[]> {
  const { rows } = await pool.query<{
    as_of_month: string;
    location: string;
    qb_category: string;
    ending_value: number;
    purchases_value: number;
    consumed_value: number;
  }>(
    `SELECT l.as_of_month,
            l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value,
            COALESCE(${purchasesExpr('l.as_of_month')}, 0)::float8 AS purchases_value,
            COALESCE(${CONSUMED_EXPR}, 0)::float8 AS consumed_value
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
    endingValue: r.ending_value,
    purchasesValue: r.purchases_value,
    consumedValue: r.consumed_value,
  }));
}

/**
 * The first month the ledger is anchored to a real count.
 *
 * That month carries the whole catch-up write-off from every unanchored month
 * before it, so its COGS is a cutover discharge, not operating cost of goods —
 * $2,170,590 combined at 2026-01 against ~$290k in a normal month. It has to be
 * labelled wherever COGS is shown by month, or someone reads a $2.2M January.
 *
 * Derived, not hardcoded: 2025-12 has zero anchored rows and 2026-01 has 9,463.
 * A ratio heuristic was tried first and rejected — at location grain it
 * false-positived on Florida (76.9% in a normal month) and on Texas's first
 * trading month.
 */
export async function fetchFirstAnchoredMonth(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ month: string | null }>(
    `SELECT min(as_of_month) AS month FROM inventory.lot_depletion_ledger WHERE lot_anchored`,
  );
  return rows[0]?.month ?? null;
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

/**
 * One lot standing behind a posted inventory-close line, at the close month.
 *
 * The grain the accountants asked to see next to the entry: which lots make up
 * the FIFO figure the adjustment moves the books to.
 */
export interface JeLotDetailRow {
  receiptId: string;
  location: string;
  qbCategory: string;
  productName: string | null;
  ndc: string | null;
  lotNumber: string | null;
  vendor: string | null;
  dateReceived: string | null;
  qtyReceived: number | null;
  unitCost: number | null;
  totalCost: number | null;
  /** Consumed to date THROUGH the close month — `qty_consumed` is per-month. */
  qtyConsumed: number;
  qtyRemaining: number;
  remainingValue: number | null;
  isOpeningBalance: boolean;
  lotAnchored: boolean;
}

/**
 * The lots behind a stored inventory-close draft, looked up by the receipt ids
 * the draft already carries on `sourceRowKeys`.
 *
 * KEYED BY THE DRAFT, NOT RECOMPUTED. The entry was generated from a particular
 * reading of the ledger; re-deriving the category cut here would produce a file
 * that can disagree with the entry it is attached to the moment anything moves
 * upstream. Reading back the exact receipt ids the draft stored makes the detail
 * a view OF the entry rather than a second opinion about it.
 *
 * `as_of_month` is the close month, so `remaining_value` is the month-end figure
 * the FIFO target was summed from and `qty_consumed` is summed across every month
 * up to it — the same convention `/api/inventory/lots` uses.
 */
export async function fetchJeLotDetail(
  pool: Pool,
  receiptIds: readonly string[],
  asOfMonth: string,
): Promise<JeLotDetailRow[]> {
  if (receiptIds.length === 0) return [];
  const { rows } = await pool.query<{
    receipt_id: string;
    location: string;
    qb_category: string;
    product_name: string | null;
    ndc: string | null;
    lot_number: string | null;
    vendor: string | null;
    date_received: string | null;
    qty_received: number | null;
    unit_cost: number | null;
    total_cost: number | null;
    qty_consumed: number;
    qty_remaining: number;
    remaining_value: number | null;
    is_opening_balance: boolean;
    lot_anchored: boolean;
  }>(
    `WITH ${PRODUCT_NAMES_CTE},
          consumed AS (
            SELECT receipt_id, sum(qty_consumed)::float8 AS consumed_to_date
            FROM inventory.lot_depletion_ledger
            WHERE as_of_month <= $1 AND receipt_id = ANY($2::text[])
            GROUP BY receipt_id
          )
     SELECT l.receipt_id,
            l.location,
            ${CATEGORY_EXPR} AS qb_category,
            ${RESOLVED_PRODUCT_NAME} AS product_name,
            NULLIF(p.ndc, '') AS ndc,
            p.lot_number,
            p.vendor,
            p.date_received::text AS date_received,
            p.qty_received::float8 AS qty_received,
            p.unit_cost::float8 AS unit_cost,
            p.total_cost::float8 AS total_cost,
            COALESCE(c.consumed_to_date, 0) AS qty_consumed,
            l.qty_remaining::float8 AS qty_remaining,
            l.remaining_value::float8 AS remaining_value,
            l.is_opening_balance,
            COALESCE(l.lot_anchored, false) AS lot_anchored
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     LEFT JOIN product_names pn ON pn.key = l.product_key
     LEFT JOIN consumed c ON c.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1
       AND l.receipt_id = ANY($2::text[])
       AND ${NOT_COLLAPSED}
     ORDER BY ${CATEGORY_EXPR}, ${RESOLVED_PRODUCT_NAME} NULLS LAST, p.date_received`,
    [asOfMonth, [...receiptIds]],
  );
  return rows.map((r) => ({
    receiptId: r.receipt_id,
    location: r.location,
    qbCategory: r.qb_category,
    productName: r.product_name,
    ndc: r.ndc,
    lotNumber: r.lot_number,
    vendor: r.vendor,
    dateReceived: r.date_received,
    qtyReceived: r.qty_received,
    unitCost: r.unit_cost,
    totalCost: r.total_cost,
    qtyConsumed: r.qty_consumed,
    qtyRemaining: r.qty_remaining,
    remainingValue: r.remaining_value,
    isOpeningBalance: r.is_opening_balance,
    lotAnchored: r.lot_anchored,
  }));
}
