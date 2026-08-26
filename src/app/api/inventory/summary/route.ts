import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import { fetchRollbackRows } from '@/lib/inventory-rollback';
import type { Basis, SummaryResponse, ValuationSummaryRow } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SummaryQueryRow {
  as_of_month: string;
  location: string;
  qb_category: string;
  basis: Basis;
  on_hand_qty: number;
  on_hand_value_fifo: number;
  receipts_value_in_month: number;
  consumed_value_in_month: number;
  opening_balance_value: number;
  shortfall_count: number;
  lifefile_qty_left_total: number | null;
  cash_estimated_value: number | null;
  pre_floor_collapsed_value: number | null;
  waste_value_in_month: number | null;
  shrink_value_in_month: number | null;
}

const EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'Month', key: 'as_of_month' },
  { header: 'Location', key: 'location' },
  { header: 'QB Category', key: 'qb_category' },
  { header: 'Basis', key: 'basis' },
  { header: 'On-Hand Qty', key: 'on_hand_qty' },
  { header: 'On-Hand Value (FIFO)', key: 'on_hand_value_fifo', currency: true },
  { header: 'Receipts Value (Month)', key: 'receipts_value_in_month', currency: true },
  { header: 'Consumed Value (Month)', key: 'consumed_value_in_month', currency: true },
  { header: 'Opening Balance Value', key: 'opening_balance_value', currency: true },
  { header: 'Shortfall Count', key: 'shortfall_count' },
  { header: 'LifeFile Qty Left', key: 'lifefile_qty_left_total' },
  { header: 'Estimated-Timing Value (Cash)', key: 'cash_estimated_value', currency: true },
  { header: 'Excluded Pre-Conversion Value', key: 'pre_floor_collapsed_value', currency: true },
  { header: 'Waste (Month)', key: 'waste_value_in_month', currency: true },
  { header: 'Shrink (Month)', key: 'shrink_value_in_month', currency: true },
];

// Rollback (backward) reconstruction — the independent cross-check, on the
// settled receipt-priced methodology.
const ROLLBACK_COLUMNS: ExportColumn[] = [
  { header: 'Month', key: 'as_of_month' },
  { header: 'Location', key: 'location' },
  { header: 'Reconstruction (Receipt-Priced)', key: 'value_floor', currency: true },
  { header: 'On-Hand Qty', key: 'on_hand_qty' },
  { header: 'Uncosted Qty', key: 'uncosted_qty' },
  { header: 'OOS Ratio', key: 'oos_ratio' },
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const basis = (searchParams.get('basis') === 'cash' ? 'cash' : 'accrual') as Basis;
    const location = searchParams.get('location');
    const format = searchParams.get('format') ?? 'json';

    const pool = getRdsPool();
    const params: string[] = [basis];
    let where = 'basis = $1';
    if (location && location !== 'all') {
      params.push(location);
      where += ` AND location = $${params.length}`;
    }

    // waste/shrink arrived with the 2026-08-26 adjustment-feed deploy; guard so a
    // pre-feed environment degrades to nulls instead of a 500.
    const wsCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'inventory' AND table_name = 'fifo_valuation_summary'
         AND column_name IN ('waste_value_in_month', 'shrink_value_in_month')`,
    );
    const hasWasteShrink = wsCols.rows.length === 2;
    const wasteExpr = hasWasteShrink ? 'waste_value_in_month::float8' : 'NULL::float8';
    const shrinkExpr = hasWasteShrink ? 'shrink_value_in_month::float8' : 'NULL::float8';

    const result = await pool.query<SummaryQueryRow>(
      `SELECT as_of_month, location, qb_category, basis,
              on_hand_qty::float8 AS on_hand_qty,
              on_hand_value_fifo::float8 AS on_hand_value_fifo,
              receipts_value_in_month::float8 AS receipts_value_in_month,
              consumed_value_in_month::float8 AS consumed_value_in_month,
              opening_balance_value::float8 AS opening_balance_value,
              shortfall_count,
              lifefile_qty_left_total::float8 AS lifefile_qty_left_total,
              cash_estimated_value::float8 AS cash_estimated_value,
              pre_floor_collapsed_value::float8 AS pre_floor_collapsed_value,
              ${wasteExpr} AS waste_value_in_month,
              ${shrinkExpr} AS shrink_value_in_month
       FROM inventory.fifo_valuation_summary
       WHERE ${where}
       ORDER BY as_of_month, location, qb_category`,
      params,
    );

    const rows: ValuationSummaryRow[] = result.rows;
    const months = [...new Set(rows.map((r) => r.as_of_month))].sort();
    const latestMonth = months.length > 0 ? months[months.length - 1] : null;

    // Locations/categories come from the unfiltered table so selectors stay complete.
    const meta = await pool.query<{ location: string; qb_category: string }>(
      `SELECT DISTINCT location, qb_category FROM inventory.fifo_valuation_summary`,
    );
    const locations = [...new Set(meta.rows.map((r) => r.location))].sort();
    const categories = [...new Set(meta.rows.map((r) => r.qb_category))].sort();

    // Cash basis rows appear once the Data Loader ships the QB-linkage transform
    // (Phase 4) — the UI toggle un-grays itself when they exist.
    const basisRes = await pool.query<{ has_cash: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM inventory.fifo_valuation_summary WHERE basis = 'cash') AS has_cash`,
    );
    const hasCashBasis = basisRes.rows[0]?.has_cash ?? false;

    // Which months are anchored to LifeFile actuals — the current month lot-by-lot
    // (lot_anchored ledger rows) plus every count-anchored month-end. The test is
    // SHRINK, not waste: waste is a dated feed and writes into pre-window months
    // too (2025-11 carries $6K of it), while a shrink figure exists only where a
    // count was applied. Every count-anchored month from the anchoring boundary
    // forward counts, including zero-shrink months between anchored neighbors.
    const anchoredRes = await pool.query<{ as_of_month: string }>(
      hasWasteShrink
        ? `SELECT DISTINCT as_of_month FROM inventory.lot_depletion_ledger WHERE lot_anchored = true
           UNION
           SELECT as_of_month FROM inventory.fifo_valuation_summary
           WHERE basis = 'accrual'
             AND as_of_month >= (
               SELECT MIN(as_of_month) FROM inventory.fifo_valuation_summary
               WHERE basis = 'accrual' AND COALESCE(shrink_value_in_month, 0) > 0
             )
           GROUP BY as_of_month
           ORDER BY as_of_month`
        : `SELECT DISTINCT as_of_month FROM inventory.lot_depletion_ledger WHERE lot_anchored = true ORDER BY as_of_month`,
    );
    const anchoredMonths = anchoredRes.rows.map((r) => r.as_of_month);

    if (format === 'csv' || format === 'xlsx') {
      const exportRows: Record<string, CellValue>[] = rows.map((r) => ({ ...r }));
      const filename = `fifo-valuation_${location && location !== 'all' ? location.replace(/\s+/g, '-') : 'all'}_${latestMonth ?? 'na'}_${basis}`;

      // The As-of page's headline numbers (receipt-priced floor / full-coverage estimate) come
      // from the rollback valuation, not this summary table — until 2026-08-18 they were shown
      // on screen but absent from every export. Best-effort: a rollback hiccup never blocks the
      // summary export, the extra sheet/section is just omitted.
      let rollbackRows: Record<string, CellValue>[] = [];
      try {
        rollbackRows = (await fetchRollbackRows(pool))
          .filter((r) => !location || location === 'all' || r.location === location)
          .map((r) => ({
            as_of_month: r.as_of_month,
            location: r.location,
            value_floor: r.value_floor,
            on_hand_qty: r.on_hand_qty,
            uncosted_qty: r.uncosted_qty,
            oos_ratio: r.oos_ratio,
          }));
      } catch (rollbackErr) {
        console.warn('[inventory/summary GET] rollback sheet skipped:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
      }

      if (format === 'csv') {
        const res = csvResponse(EXPORT_COLUMNS, exportRows, filename);
        if (rollbackRows.length === 0) return res;
        const [body, rollbackBody] = await Promise.all([
          res.text(),
          csvResponse(ROLLBACK_COLUMNS, rollbackRows, filename).text(),
        ]);
        return new NextResponse(
          `${body}\r\n\r\nRollback reconstruction (receipt-priced cross-check)\r\n${rollbackBody}`,
          { headers: res.headers },
        );
      }
      const note = `FIFO Inventory Valuation Summary — basis: ${basis}, generated ${new Date().toISOString()} (data as of nightly Data Loader run)`;
      const sheets = [{ name: 'Valuation Summary', columns: EXPORT_COLUMNS, rows: exportRows }];
      if (rollbackRows.length > 0) {
        sheets.push({ name: 'Rollback Cross-Check', columns: ROLLBACK_COLUMNS, rows: rollbackRows });
      }
      return xlsxResponse(sheets, filename, note);
    }

    const body: SummaryResponse = { basis, months, locations, categories, rows, latestMonth, hasCashBasis, anchoredMonths };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching inventory summary:', error);
    return NextResponse.json({ error: 'Failed to load inventory valuation summary' }, { status: 500 });
  }
}
