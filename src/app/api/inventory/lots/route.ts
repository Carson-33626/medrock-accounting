import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import { PRODUCT_NAMES_CTE, RESOLVED_PRODUCT_NAME } from '@/lib/inventory-sql';
import type { LotRow, LotsResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface LotQueryRow extends LotRow {
  total_rows: string;
}

const EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'Location', key: 'location' },
  { header: 'Product', key: 'product_name' },
  { header: 'NDC', key: 'ndc' },
  { header: 'Lot Number', key: 'lot_number' },
  { header: 'Vendor', key: 'vendor' },
  { header: 'QB Category', key: 'qb_category' },
  { header: 'Date Received', key: 'date_received' },
  { header: 'Qty Received', key: 'qty_received' },
  { header: 'Unit Cost', key: 'unit_cost', currency: true },
  { header: 'Total Cost', key: 'total_cost', currency: true },
  { header: 'Qty Consumed', key: 'qty_consumed' },
  { header: 'Qty Remaining', key: 'qty_remaining' },
  { header: 'Remaining Value', key: 'remaining_value', currency: true },
  { header: 'Fully Used (Month)', key: 'fully_used_month' },
  { header: 'Opening Balance', key: 'is_opening_balance' },
  { header: 'Shortfall', key: 'had_shortfall' },
  { header: 'LifeFile Anchored', key: 'lot_anchored' },
];

// $1 is always the as_of_month. qty_consumed in the ledger is PER-MONTH
// consumption (see fifo_transform.py), so consumed-to-date is the sum of all
// months up to the requested one.
function buildLotsQuery(conditions: string[], orderBy: string, paramCount: number): string {
  return `WITH ${PRODUCT_NAMES_CTE},
       consumed AS (
         SELECT receipt_id, sum(qty_consumed)::float8 AS consumed_to_date,
                min(as_of_month) AS first_month
         FROM inventory.lot_depletion_ledger
         WHERE as_of_month <= $1
         GROUP BY receipt_id
       )
       SELECT l.receipt_id, l.location, l.product_key,
              p.date_received::text AS date_received,
              p.ndc,
              ${RESOLVED_PRODUCT_NAME} AS product_name,
              p.lot_number, p.vendor,
              COALESCE(p.qb_category, 'Opening Balance') AS qb_category,
              p.qty_received::float8 AS qty_received,
              p.unit_cost::float8 AS unit_cost,
              p.total_cost::float8 AS total_cost,
              COALESCE(c.consumed_to_date, 0) AS qty_consumed,
              l.qty_remaining::float8 AS qty_remaining,
              l.remaining_value::float8 AS remaining_value,
              l.fully_used_month, l.is_opening_balance, l.had_shortfall,
              CASE WHEN l.is_opening_balance THEN c.first_month END AS ob_as_of_month,
              COALESCE(l.lot_anchored, false) AS lot_anchored,
              count(*) OVER() AS total_rows
       FROM inventory.lot_depletion_ledger l
       LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       LEFT JOIN product_names pn ON pn.key = l.product_key
       LEFT JOIN consumed c ON c.receipt_id = l.receipt_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${paramCount - 1} OFFSET $${paramCount}`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const location = searchParams.get('location');
    const category = searchParams.get('category');
    const status = searchParams.get('status') ?? 'all';
    const search = searchParams.get('search')?.trim() ?? '';
    const requestedMonth = searchParams.get('month');
    const format = searchParams.get('format') ?? 'json';
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(searchParams.get('offset') ?? '0', 10) || 0, 0);

    const pool = getRdsPool();

    const monthResult = await pool.query<{ m: string | null }>(
      `SELECT max(as_of_month) AS m FROM inventory.lot_depletion_ledger`,
    );
    const month = requestedMonth ?? monthResult.rows[0]?.m ?? null;
    if (!month) {
      const empty: LotsResponse = { month: null, total: 0, limit, offset, rows: [] };
      return NextResponse.json(empty);
    }

    const params: Array<string | number> = [month];
    const conditions: string[] = ['l.as_of_month = $1'];

    if (location && location !== 'all') {
      params.push(location);
      conditions.push(`l.location = $${params.length}`);
    }
    if (category && category !== 'all') {
      params.push(category);
      conditions.push(`COALESCE(p.qb_category, 'Opening Balance') = $${params.length}`);
    }
    if (status === 'open') {
      conditions.push('l.qty_remaining > 0');
    } else if (status === 'fully_used') {
      conditions.push('l.fully_used_month IS NOT NULL');
    }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(
        `(${RESOLVED_PRODUCT_NAME} ILIKE $${n} OR p.ndc_norm ILIKE $${n} OR p.lot_number ILIKE $${n} OR l.product_key ILIKE $${n})`,
      );
    }

    params.push(limit, offset);

    const result = await pool.query<LotQueryRow>(
      buildLotsQuery(
        conditions,
        'l.qty_remaining > 0 DESC, p.date_received ASC NULLS FIRST, l.receipt_id',
        params.length,
      ),
      params,
    );

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_rows, 10) : 0;
    const rows: LotRow[] = result.rows.map((r) => {
      const { total_rows: _ignored, ...row } = r;
      void _ignored;
      return row;
    });

    if (format === 'csv' || format === 'xlsx') {
      // Exports ignore pagination — pull everything matching the filters (cap 50k).
      const exportParams = params.slice(0, params.length - 2);
      exportParams.push(50000, 0);
      const exportResult = await pool.query<LotQueryRow>(
        buildLotsQuery(
          conditions,
          `l.location, ${RESOLVED_PRODUCT_NAME} NULLS LAST, p.date_received`,
          exportParams.length,
        ),
        exportParams,
      );
      const exportRows: Record<string, CellValue>[] = exportResult.rows.map((r) => ({
        location: r.location,
        product_name: r.product_name ?? r.product_key,
        ndc: r.ndc,
        lot_number: r.lot_number,
        vendor: r.vendor,
        qb_category: r.qb_category,
        date_received: r.date_received ?? (r.ob_as_of_month ? `As of ${r.ob_as_of_month}` : null),
        qty_received: r.qty_received,
        unit_cost: r.unit_cost,
        total_cost: r.total_cost,
        qty_consumed: r.qty_consumed,
        qty_remaining: r.qty_remaining,
        remaining_value: r.remaining_value,
        fully_used_month: r.fully_used_month,
        is_opening_balance: r.is_opening_balance,
        had_shortfall: r.had_shortfall,
        lot_anchored: r.lot_anchored,
      }));
      const filename = `fifo-lots_${location && location !== 'all' ? location.replace(/\s+/g, '-') : 'all'}_${month}_accrual`;
      if (format === 'csv') {
        return csvResponse(EXPORT_COLUMNS, exportRows, filename);
      }
      const note = `FIFO Lot Ledger — month: ${month}, accrual basis, generated ${new Date().toISOString()}`;
      return xlsxResponse([{ name: 'Lot Ledger', columns: EXPORT_COLUMNS, rows: exportRows }], filename, note);
    }

    const body: LotsResponse = { month, total, limit, offset, rows };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching inventory lots:', error);
    return NextResponse.json({ error: 'Failed to load lot ledger' }, { status: 500 });
  }
}
