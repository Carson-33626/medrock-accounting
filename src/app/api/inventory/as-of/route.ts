import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { fetchCategoryLedgerValues } from '@/lib/inventory/close-server';
import type { AsOfCategoryRow, AsOfResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Point-in-time inventory value at (location, category) grain, for ONE month.
 *
 * WHY THIS EXISTS instead of reusing /api/inventory/summary: the as-of page and
 * the inventory-close JE have to state the same figures, and they did not.
 * `inventory.fifo_valuation_summary` and `inventory.lot_depletion_ledger` agree
 * on the TOTAL to the cent but disagree per CATEGORY — the summary table folds
 * opening-balance lots into the product's real category, while the close (which
 * has to post to a real QuickBooks sub-account, and an OB lot has none) leaves
 * them under 'Opening Balance'. Verified on 2026-03: identical $7,014,971.32
 * totals, but Texas Compound Ingredient reads $507,498.36 in the summary against
 * $135,659.08 in the ledger — the $372,771.50 of Texas opening balance.
 *
 * So this route calls `fetchCategoryLedgerValues` — the SAME function the close
 * computes its category lines from — rather than re-deriving the numbers. Any
 * change to the close's grain moves both screens together, by construction.
 *
 * `receiptIds` is deliberately dropped: it is thousands of ids per category and
 * the browser never needs them (the drill-down re-queries by filter instead).
 */
export async function GET(request: NextRequest) {
  try {
    const pool = getRdsPool();

    const monthsResult = await pool.query<{ as_of_month: string }>(
      `SELECT DISTINCT as_of_month FROM inventory.lot_depletion_ledger ORDER BY as_of_month`,
    );
    const months = monthsResult.rows.map((r) => r.as_of_month);
    if (months.length === 0) {
      const empty: AsOfResponse = { month: null, months: [], rows: [] };
      return NextResponse.json(empty);
    }

    const requested = new URL(request.url).searchParams.get('month');
    // An unknown month would return zero rows and read on screen as "inventory
    // was worth $0", so fall back to the newest month we actually hold.
    const month = requested && months.includes(requested) ? requested : months[months.length - 1];

    const values = await fetchCategoryLedgerValues(pool, month);
    const rows: AsOfCategoryRow[] = values.map((v) => ({
      location: v.location,
      qbCategory: v.qbCategory,
      value: v.endingValue,
      lotCount: v.lotCount,
    }));

    const body: AsOfResponse = { month, months, rows };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching as-of inventory value:', error);
    return NextResponse.json({ error: 'Failed to load as-of inventory value' }, { status: 500 });
  }
}
