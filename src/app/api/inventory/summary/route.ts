import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
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

    const result = await pool.query<SummaryQueryRow>(
      `SELECT as_of_month, location, qb_category, basis,
              on_hand_qty::float8 AS on_hand_qty,
              on_hand_value_fifo::float8 AS on_hand_value_fifo,
              receipts_value_in_month::float8 AS receipts_value_in_month,
              consumed_value_in_month::float8 AS consumed_value_in_month,
              opening_balance_value::float8 AS opening_balance_value,
              shortfall_count,
              lifefile_qty_left_total::float8 AS lifefile_qty_left_total
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

    if (format === 'csv' || format === 'xlsx') {
      const exportRows: Record<string, CellValue>[] = rows.map((r) => ({ ...r }));
      const filename = `fifo-valuation_${location && location !== 'all' ? location.replace(/\s+/g, '-') : 'all'}_${latestMonth ?? 'na'}_${basis}`;
      if (format === 'csv') {
        return csvResponse(EXPORT_COLUMNS, exportRows, filename);
      }
      const note = `FIFO Inventory Valuation Summary — basis: ${basis}, generated ${new Date().toISOString()} (data as of nightly Data Loader run)`;
      return xlsxResponse([{ name: 'Valuation Summary', columns: EXPORT_COLUMNS, rows: exportRows }], filename, note);
    }

    const body: SummaryResponse = { basis, months, locations, categories, rows, latestMonth };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching inventory summary:', error);
    return NextResponse.json({ error: 'Failed to load inventory valuation summary' }, { status: 500 });
  }
}
