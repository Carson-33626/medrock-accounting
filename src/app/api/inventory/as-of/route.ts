import { NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { fetchCategoryLedgerSeries } from '@/lib/inventory/ledger-values';
import type { AsOfCategoryRow, AsOfResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Point-in-time inventory value at (month, location, category) grain — the whole
 * history in one response.
 *
 * Every month rather than one, because the FIFO valuation page's month picker is
 * meant to be moved around freely: totals, breakdowns and the trend line all
 * re-cut from what is already in the browser instead of a fetch per step. It is
 * roughly 15 cells a month, so the full series is a few hundred rows.
 *
 * The numbers come from `fetchCategoryLedgerSeries`, the same module the close
 * reads — see lib/inventory/ledger-values.ts for why this cannot be sourced from
 * `fifo_valuation_summary`.
 */
export async function GET() {
  try {
    const series = await fetchCategoryLedgerSeries(getRdsPool());

    const rows: AsOfCategoryRow[] = series.map((r) => ({
      month: r.month,
      location: r.location,
      qbCategory: r.qbCategory,
      value: r.value,
      lotCount: r.lotCount,
    }));
    const months = [...new Set(series.map((r) => r.month))].sort();

    const body: AsOfResponse = {
      months,
      latestMonth: months.length > 0 ? months[months.length - 1] : null,
      rows,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching as-of inventory value:', error);
    return NextResponse.json({ error: 'Failed to load as-of inventory value' }, { status: 500 });
  }
}
