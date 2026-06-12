import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { csvResponse, xlsxResponse, type CellValue, type ExportColumn } from '@/lib/inventory-export';
import { PRODUCT_NAMES_CTE, RESOLVED_PRODUCT_NAME } from '@/lib/inventory-sql';
import type { LotsResponse, ProductGroupRow } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ProductGroupQueryRow extends ProductGroupRow {
  total_rows: string;
}

interface LotExportRow {
  location: string;
  product_key: string;
  date_received: string | null;
  ndc: string | null;
  product_name: string | null;
  lot_number: string | null;
  vendor: string | null;
  qb_category: string;
  qty_received: number | null;
  unit_cost: number | null;
  total_cost: number | null;
  qty_consumed: number;
  qty_remaining: number;
  remaining_value: number | null;
  fully_used_month: string | null;
  is_opening_balance: boolean;
  had_shortfall: boolean;
  lot_anchored: boolean;
  ob_as_of_month: string | null;
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

// Whitelisted sortable columns for the product-grouped table -> select aliases.
const SORTABLE_COLUMNS: Record<string, string> = {
  product_name: 'product_name',
  qb_category: 'qb_category',
  locations: 'locations',
  lot_count: 'lot_count',
  open_lots: 'open_lots',
  last_received: 'last_received',
  qty_consumed: 'qty_consumed',
  qty_remaining: 'qty_remaining',
  remaining_value: 'remaining_value',
};

// Shared lot-grain base: $1 is always the as_of_month. qty_consumed in the
// ledger is PER-MONTH consumption (see fifo_transform.py), so consumed-to-date
// is the sum of all months up to the requested one.
function lotRowsCte(conditions: string[]): string {
  return `WITH ${PRODUCT_NAMES_CTE},
       consumed AS (
         SELECT receipt_id, sum(qty_consumed)::float8 AS consumed_to_date,
                min(as_of_month) AS first_month
         FROM inventory.lot_depletion_ledger
         WHERE as_of_month <= $1
         GROUP BY receipt_id
       ),
       lot_rows AS (
         SELECT l.receipt_id, l.location, l.product_key,
                p.date_received,
                NULLIF(p.ndc, '') AS ndc,
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
                COALESCE(l.lot_anchored, false) AS lot_anchored,
                CASE WHEN l.is_opening_balance THEN c.first_month END AS ob_as_of_month
         FROM inventory.lot_depletion_ledger l
         LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
         LEFT JOIN product_names pn ON pn.key = l.product_key
         LEFT JOIN consumed c ON c.receipt_id = l.receipt_id
         WHERE ${conditions.join(' AND ')}
       )`;
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
    const sortParam = searchParams.get('sort');
    const sortDir = searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
    const sortTarget = sortParam ? SORTABLE_COLUMNS[sortParam] : undefined;
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

    if (format === 'csv' || format === 'xlsx') {
      // Exports stay LOT-grain (full detail), ignore pagination (cap 50k).
      const exportParams = [...params, 50000, 0];
      const exportResult = await pool.query<LotExportRow>(
        `${lotRowsCte(conditions)}
         SELECT location, product_key, date_received::text AS date_received, ndc,
                product_name, lot_number, vendor, qb_category, qty_received,
                unit_cost, total_cost, qty_consumed, qty_remaining,
                remaining_value, fully_used_month, is_opening_balance,
                had_shortfall, lot_anchored, ob_as_of_month
         FROM lot_rows
         ORDER BY location, product_name NULLS LAST, date_received
         LIMIT $${exportParams.length - 1} OFFSET $${exportParams.length}`,
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

    // JSON: one row per product, lots aggregated beneath the filters.
    // First key is an expression, so it can't use the select alias — spell out
    // the aggregate. Subsequent keys are bare aliases (allowed).
    const defaultOrder = 'sum(qty_remaining) > 0 DESC, product_name NULLS LAST, product_key';
    const orderBy = sortTarget ? `${sortTarget} ${sortDir} NULLS LAST, product_key` : defaultOrder;
    const pageParams = [...params, limit, offset];

    const result = await pool.query<ProductGroupQueryRow>(
      `${lotRowsCte(conditions)}
       SELECT product_key,
              max(product_name) AS product_name,
              max(ndc) AS ndc,
              COALESCE(
                max(CASE WHEN qb_category <> 'Opening Balance' THEN qb_category END),
                'Opening Balance'
              ) AS qb_category,
              string_agg(DISTINCT replace(location, 'MedRock ', ''), ', ' ORDER BY replace(location, 'MedRock ', '')) AS locations,
              count(*)::int AS lot_count,
              (count(*) FILTER (WHERE qty_remaining > 0))::int AS open_lots,
              max(date_received)::text AS last_received,
              sum(qty_consumed)::float8 AS qty_consumed,
              sum(qty_remaining)::float8 AS qty_remaining,
              sum(remaining_value)::float8 AS remaining_value,
              bool_or(is_opening_balance) AS has_opening_balance,
              bool_or(had_shortfall) AS had_shortfall,
              count(*) OVER() AS total_rows
       FROM lot_rows
       GROUP BY product_key
       ORDER BY ${orderBy}
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_rows, 10) : 0;
    const rows: ProductGroupRow[] = result.rows.map((r) => {
      const { total_rows: _ignored, ...row } = r;
      void _ignored;
      return row;
    });

    const body: LotsResponse = { month, total, limit, offset, rows };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching inventory lots:', error);
    return NextResponse.json({ error: 'Failed to load lot ledger' }, { status: 500 });
  }
}
