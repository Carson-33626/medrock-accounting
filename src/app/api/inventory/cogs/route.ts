import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import {
  fetchCategoryLedgerMovementSeries,
  fetchFirstAnchoredMonth,
} from '@/lib/inventory/ledger-values';
import { accountsForCategory } from '@/lib/inventory/category-accounts';
import {
  buildCogsRollForward,
  movementLocations,
  type CogsRollForward,
  type CogsRollForwardLine,
} from '@/lib/inventory/cogs-rollforward';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import type { CategoryLedgerMovementRow, CogsSeriesResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One row per (location, category) of the two-month roll-forward, plus a total
 * row per location. `row_type` is what a pivot filters on so the totals cannot be
 * double-counted against the detail they sum.
 */
const ROLL_FORWARD_COLUMNS: ExportColumn[] = [
  { header: 'Row Type', key: 'row_type' },
  { header: 'Month', key: 'month' },
  { header: 'Location', key: 'location' },
  { header: 'QB Category', key: 'qb_category' },
  { header: 'QB COGS Account', key: 'qb_cogs_account' },
  { header: 'Beginning', key: 'beginning', currency: true },
  { header: 'Purchases', key: 'purchases', currency: true },
  { header: 'COGS', key: 'cogs', currency: true },
  { header: 'Shrink & Anchor Adj', key: 'adjustment', currency: true },
  { header: 'Ending', key: 'ending', currency: true },
  { header: 'Prior Month', key: 'prior_month' },
  { header: 'Prior COGS', key: 'prior_cogs', currency: true },
  { header: 'Change vs Prior', key: 'change', currency: true },
  { header: 'Month Flag', key: 'flag' },
  { header: 'In Operating COGS', key: 'operating' },
  { header: 'Anchored Month', key: 'anchored' },
];

/** The headline figures, so the file says what the screen said. */
const SUMMARY_COLUMNS: ExportColumn[] = [
  { header: 'Figure', key: 'figure' },
  { header: 'Value', key: 'value' },
];

/**
 * Cost of goods sold and the inventory movement around it, at (month, location,
 * category) grain — the whole history in one response, the same shape and for the
 * same reason as `/api/inventory/as-of`: the FIFO page's month picker is meant to
 * be moved around freely, so the browser re-cuts what it already has instead of
 * fetching per step.
 *
 * Sourced from `fetchCategoryLedgerMovementSeries` — the same `remaining_value`,
 * receipt-dated purchases and `qty_consumed x unit_cost` the month-end close reads,
 * so a figure here and the same cell on the close are the same number by
 * construction rather than by coincidence. A month's BEGINNING is not transmitted:
 * it is the prior month's ending, off this same series.
 *
 * `firstAnchoredMonth` rides along because that month's COGS is a cutover discharge
 * (every unanchored month's write-off landing at once) and must never be read as
 * operating cost of goods.
 *
 * `?format=csv|xlsx` exports what the COGS tab shows for the current scope
 * (`location`, `month`): the two-month roll-forward, carrying the cutover/true-up
 * flag and the QB COGS account into the file — an export that lost the flags would
 * put a $2.2M January into a spreadsheet with nothing to say it is not cost of
 * goods.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') ?? 'json';
    const location = searchParams.get('location') ?? 'all';
    const month = searchParams.get('month');

    const pool = getRdsPool();
    const [movement, firstAnchoredMonth] = await Promise.all([
      fetchCategoryLedgerMovementSeries(pool),
      fetchFirstAnchoredMonth(pool),
    ]);

    if (format === 'csv' || format === 'xlsx') {
      // No month on the query string means the caller wants the latest close —
      // the same month the page opens on.
      const latest = movement.reduce<string | null>(
        (max, r) => (max === null || r.month > max ? r.month : max),
        null,
      );
      const target = month ?? latest;
      if (target === null) {
        return NextResponse.json({ error: 'No lot-ledger months to export' }, { status: 404 });
      }
      return exportRollForward(movement, firstAnchoredMonth, location, target, format);
    }

    const body: CogsSeriesResponse = { rows: movement, firstAnchoredMonth };
    return NextResponse.json(body);
  } catch (error) {
    console.error('[inventory/cogs GET]', error);
    return NextResponse.json({ error: 'Failed to load COGS series' }, { status: 500 });
  }
}

/**
 * The export is built off the SAME `buildCogsRollForward` the screen draws from,
 * so the flags, the aggregation and the identity in the file are the ones the
 * reader saw — not a second implementation that ought to agree.
 */
async function exportRollForward(
  movement: CategoryLedgerMovementRow[],
  firstAnchoredMonth: string | null,
  location: string,
  month: string,
  format: 'csv' | 'xlsx',
): Promise<NextResponse> {
  const scoped = buildCogsRollForward(movement, { location, firstAnchoredMonth, month });
  const scopeLabel = location === 'all' ? 'All locations' : location;
  const anchored = firstAnchoredMonth === null || month >= firstAnchoredMonth;

  const toRow = (
    rf: CogsRollForward,
    line: CogsRollForwardLine,
    label: string,
    rowType: 'category' | 'total',
  ): Record<string, CellValue> => ({
    row_type: rowType,
    month: rf.month,
    location: label,
    qb_category: rowType === 'total' ? 'TOTAL' : line.qbCategory,
    qb_cogs_account:
      rowType === 'total' ? 'Cost of Goods Sold (5000.xx)' : accountsForCategory(line.qbCategory).cogs,
    beginning: line.beginning,
    purchases: line.purchases,
    cogs: line.cogs,
    adjustment: line.adjustment,
    ending: line.ending,
    prior_month: rf.priorMonth ?? '',
    prior_cogs: rf.priorMonth === null ? null : line.priorCogs,
    // Withheld on exactly the months the screen withholds it: a change against a
    // cutover or true-up month is not a change in cost of goods.
    change: rf.delta === null ? null : Math.round((line.cogs - line.priorCogs) * 100) / 100,
    flag: rf.flag ?? '',
    operating: rf.flag === null ? 'yes' : 'no',
    // Months before the anchor window are ordinary COGS by this calculation but
    // were never posted, so nothing in QuickBooks corresponds to them. The screen
    // says so on its face; the file has to as well.
    anchored: anchored ? 'yes' : 'no — simulation-only, never posted',
  });

  const rowsFor = (rf: CogsRollForward, label: string): Record<string, CellValue>[] => [
    ...rf.lines.map((l) => toRow(rf, l, label, 'category')),
    toRow(rf, rf.total, label, 'total'),
  ];

  // With the scope on 'all', the detail is the per-location cut — the class split
  // month-end allocation runs on, and the grain that actually sums. The aggregate
  // is carried as its own total row rather than mixed in with the detail.
  const detailRows: Record<string, CellValue>[] = [];
  if (location === 'all') {
    for (const loc of movementLocations(movement, [month, scoped.priorMonth])) {
      detailRows.push(
        ...rowsFor(buildCogsRollForward(movement, { location: loc, firstAnchoredMonth, month }), loc),
      );
    }
  }
  const scopeRows = rowsFor(scoped, scopeLabel);

  const summaryRows: Record<string, CellValue>[] = [
    { figure: 'Scope', value: scopeLabel },
    { figure: 'Month', value: scoped.month },
    { figure: 'Comparison month', value: scoped.priorMonth ?? 'none — earliest month in the ledger' },
    { figure: 'Beginning inventory', value: scoped.total.beginning },
    { figure: 'Purchases', value: scoped.total.purchases },
    { figure: 'COGS (5000.xx)', value: scoped.total.cogs },
    { figure: 'Shrink & anchor (5000.55)', value: scoped.total.adjustment },
    { figure: 'Ending inventory', value: scoped.total.ending },
    { figure: 'Prior month COGS', value: scoped.priorMonth === null ? null : scoped.total.priorCogs },
    {
      figure: 'Change vs prior month',
      value: scoped.delta === null ? 'withheld — cutover or true-up month' : scoped.delta.dollars,
    },
    {
      figure: 'Change %',
      value:
        scoped.delta === null || scoped.delta.percent === null
          ? 'n/a'
          : `${scoped.delta.percent.toFixed(1)}%`,
    },
    { figure: 'Month flag', value: scoped.flag ?? 'none — operating COGS' },
    {
      figure: 'Anchored month',
      value: anchored ? 'yes' : `no — before ${firstAnchoredMonth}, simulation-only history`,
    },
    { figure: 'Comparison month flag', value: scoped.priorFlag ?? 'none — operating COGS' },
  ];

  const filename = `fifo-cogs_${location === 'all' ? 'all' : location.replace(/\s+/g, '-')}_${month}`;
  const note =
    'FIFO cost of goods sold — one month against the month before it. Beginning is the prior month-end inventory value, purchases are the lots received in the month at cost, ' +
    'and every row foots: beginning + purchases - (COGS + shrink & anchor) = ending. COGS is consumption valued at the actual purchase price of the lots it came out of, the same ' +
    'basis the month-end close posts to 5000.xx. "Shrink & anchor" is the rest of the movement — stock written down to a real physical count and the current-month anchor writing ' +
    'value back up, which post to 5000.55 Drug Waste & Shrinkage, plus opening-balance lots that carry no unit cost. Months flagged "cutover" (the first month anchored to a real ' +
    'count, carrying the catch-up write-off from every month before it) and "true-up" (negative: the anchor restoring inventory value) are NOT operating cost of goods, and the ' +
    'month-over-month change is withheld wherever either month is flagged. A month before the anchor window is ordinary COGS by this calculation but no close entry was ever ' +
    'posted for it, so nothing in QuickBooks corresponds to the figure — see the Anchored Month column.';

  if (format === 'csv') {
    return csvResponse(ROLL_FORWARD_COLUMNS, [...detailRows, ...scopeRows], filename);
  }
  return xlsxResponse(
    [
      { name: 'Summary', columns: SUMMARY_COLUMNS, rows: summaryRows, note },
      {
        name: 'Roll-forward',
        columns: ROLL_FORWARD_COLUMNS,
        rows: [...scopeRows, ...detailRows],
        note,
      },
    ],
    filename,
    note,
  );
}
