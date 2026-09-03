import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { fetchCategoryCogsSeries, fetchFirstAnchoredMonth } from '@/lib/inventory/ledger-values';
import { accountsForCategory } from '@/lib/inventory/category-accounts';
import {
  buildCogsGrid,
  cogsCell,
  isExcludedMonth,
  monthFlag,
  monthTotal,
  operatingTotal,
} from '@/lib/inventory/cogs-view';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { CogsSeriesResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One row per (month, category) in scope — the shape to pivot in Excel. */
const DETAIL_COLUMNS: ExportColumn[] = [
  { header: 'Month', key: 'month' },
  { header: 'Location', key: 'location' },
  { header: 'QB Category', key: 'qb_category' },
  { header: 'QB COGS Account', key: 'qb_cogs_account' },
  { header: 'COGS', key: 'cogs', currency: true },
  { header: 'Month Flag', key: 'flag' },
  { header: 'In Operating COGS', key: 'operating' },
];

/** One row per month — what the COGS tab shows, totals and all. */
const MONTHLY_COLUMNS: ExportColumn[] = [
  { header: 'Month', key: 'month' },
  { header: 'Location', key: 'location' },
  { header: 'Total COGS', key: 'total', currency: true },
  { header: 'Month Flag', key: 'flag' },
  { header: 'Operating COGS', key: 'operating_cogs', currency: true },
];

/**
 * Cost of goods sold at (month, location, category) grain — the whole history in
 * one response, the same shape and for the same reason as `/api/inventory/as-of`:
 * the FIFO page's month picker is meant to be moved around freely, so the browser
 * re-cuts what it already has instead of fetching per step.
 *
 * Sourced from `fetchCategoryCogsSeries`, the same `qty_consumed x unit_cost` basis
 * the month-end close posts from — so a figure here and the same cell on the close
 * are the same number, by construction rather than by coincidence.
 *
 * `firstAnchoredMonth` rides along because that month's COGS is a cutover discharge
 * (every unanchored month's write-off landing at once) and must never be read as
 * operating cost of goods.
 *
 * `?format=csv|xlsx` exports the same figures for the current scope
 * (`location`, `from`, `to`), carrying the cutover/true-up flag and the QB COGS
 * account into the file — an export that lost the flags would put a $2.2M January
 * into a spreadsheet with nothing to say it is not cost of goods.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') ?? 'json';
    const location = searchParams.get('location') ?? 'all';
    const fromMonth = searchParams.get('from') ?? undefined;
    const toMonth = searchParams.get('to') ?? undefined;

    const pool = getRdsPool();
    const [series, firstAnchoredMonth] = await Promise.all([
      fetchCategoryCogsSeries(pool),
      fetchFirstAnchoredMonth(pool),
    ]);

    if (format === 'csv' || format === 'xlsx') {
      return exportCogs(series, firstAnchoredMonth, { location, fromMonth, toMonth }, format);
    }

    const body: CogsSeriesResponse = {
      rows: series.map((r) => ({
        month: r.month,
        location: r.location,
        qbCategory: r.qbCategory,
        cogs: r.cogs,
      })),
      firstAnchoredMonth,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('[inventory/cogs GET]', error);
    return NextResponse.json({ error: 'Failed to load COGS series' }, { status: 500 });
  }
}

/**
 * The export is built off the SAME `buildCogsGrid` the screen draws from, so the
 * flags, the aggregation and the operating total in the file are the ones the
 * reader saw — not a second implementation that ought to agree.
 */
async function exportCogs(
  series: CogsSeriesResponse['rows'],
  firstAnchoredMonth: string | null,
  scope: { location: string; fromMonth: string | undefined; toMonth: string | undefined },
  format: 'csv' | 'xlsx',
): Promise<NextResponse> {
  const { location, fromMonth, toMonth } = scope;
  const grid = buildCogsGrid(series, { location, firstAnchoredMonth, fromMonth, toMonth });
  const scopeLabel = location === 'all' ? 'All locations' : location;

  const detailRows: Record<string, CellValue>[] = [];
  for (const month of grid.months) {
    const excluded = isExcludedMonth(grid, month);
    for (const qbCategory of grid.categories) {
      const value = cogsCell(grid, month, qbCategory);
      if (value === 0) continue;
      detailRows.push({
        month,
        location: scopeLabel,
        qb_category: qbCategory,
        qb_cogs_account: accountsForCategory(qbCategory).cogs,
        cogs: value,
        flag: monthFlag(grid, month) ?? '',
        operating: excluded ? 'no' : 'yes',
      });
    }
  }

  const monthlyRows: Record<string, CellValue>[] = grid.months.map((month) => ({
    month,
    location: scopeLabel,
    total: monthTotal(grid, month),
    flag: monthFlag(grid, month) ?? '',
    operating_cogs: isExcludedMonth(grid, month) ? null : monthTotal(grid, month),
  }));
  monthlyRows.push({
    month: 'Operating total',
    location: scopeLabel,
    total: null,
    flag: '',
    operating_cogs: operatingTotal(grid),
  });

  const windowLabel = `${grid.months[0] ?? 'na'}_${grid.months[grid.months.length - 1] ?? 'na'}`;
  const filename = `fifo-cogs_${location === 'all' ? 'all' : location.replace(/\s+/g, '-')}_${windowLabel}`;
  const note =
    'FIFO cost of goods sold — usage valued at the actual purchase price of the lots it came out of, the same basis the month-end close posts from. ' +
    'Months flagged "cutover" (the first month anchored to a real count, carrying the catch-up write-off from every month before it) and "true-up" ' +
    '(negative: the current-month lot anchor restoring inventory value) are NOT operating cost of goods and are excluded from the operating total. ' +
    'Waste and shrink are not included here — they post to 5000.55 Drug Waste & Shrinkage.';

  if (format === 'csv') {
    return csvResponse(DETAIL_COLUMNS, detailRows, filename);
  }
  return xlsxResponse(
    [
      { name: 'By Month', columns: MONTHLY_COLUMNS, rows: monthlyRows, note },
      { name: 'By Category', columns: DETAIL_COLUMNS, rows: detailRows, note },
    ],
    filename,
    note,
  );
}
