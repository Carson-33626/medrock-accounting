import { NextRequest, NextResponse } from 'next/server';
import { getRdsPool } from '@/lib/rds';
import { PRODUCT_NAMES_CTE, RESOLVED_PRODUCT_NAME } from '@/lib/inventory-sql';
import type { ProductDetailResponse, ProductMonthRow, ProductReceiptRow } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReceiptQueryRow extends Omit<ProductReceiptRow, 'fifo_position'> {
  rn: string;
}

interface HistoryQueryRow {
  as_of_month: string;
  qty_remaining: number;
  remaining_value: number | null;
  consumed_in_month: number;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const productKey = searchParams.get('key');
    const location = searchParams.get('location');
    if (!productKey) {
      return NextResponse.json({ error: 'Missing required parameter: key' }, { status: 400 });
    }

    const pool = getRdsPool();
    const params: string[] = [productKey];
    let locationCond = '';
    if (location && location !== 'all') {
      params.push(location);
      locationCond = ` AND l.location = $${params.length}`;
    }

    // qty_consumed in the ledger is PER-MONTH consumption (see fifo_transform.py),
    // so consumed-to-date per receipt is the sum across all its months.
    const receipts = await pool.query<ReceiptQueryRow>(
      `WITH ${PRODUCT_NAMES_CTE},
       consumed AS (
         SELECT receipt_id, sum(qty_consumed)::float8 AS consumed_to_date,
                min(as_of_month) AS first_month
         FROM inventory.lot_depletion_ledger
         WHERE product_key = $1
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
              row_number() OVER (
                PARTITION BY l.location
                ORDER BY l.is_opening_balance DESC, p.date_received ASC NULLS FIRST, l.receipt_id
              ) AS rn
       FROM inventory.lot_depletion_ledger l
       LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       LEFT JOIN product_names pn ON pn.key = l.product_key
       LEFT JOIN consumed c ON c.receipt_id = l.receipt_id
       WHERE l.product_key = $1${locationCond}
         AND l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
       ORDER BY l.location, rn`,
      params,
    );

    const history = await pool.query<HistoryQueryRow>(
      `SELECT l.as_of_month,
              sum(l.qty_remaining)::float8 AS qty_remaining,
              sum(l.remaining_value)::float8 AS remaining_value,
              sum(l.qty_consumed)::float8 AS consumed_in_month
       FROM inventory.lot_depletion_ledger l
       WHERE l.product_key = $1${locationCond}
       GROUP BY l.as_of_month
       ORDER BY l.as_of_month`,
      params,
    );

    let cumulativeConsumed = 0;
    const historyRows: ProductMonthRow[] = history.rows.map((row) => {
      cumulativeConsumed += row.consumed_in_month;
      return {
        as_of_month: row.as_of_month,
        qty_remaining: row.qty_remaining,
        remaining_value: row.remaining_value,
        cumulative_consumed: cumulativeConsumed,
        consumed_in_month: row.consumed_in_month,
      };
    });

    const receiptRows: ProductReceiptRow[] = receipts.rows.map((r) => {
      const { rn, ...rest } = r;
      return { ...rest, fifo_position: parseInt(rn, 10) };
    });

    const body: ProductDetailResponse = {
      product_key: productKey,
      product_name: receiptRows.find((r) => r.product_name)?.product_name ?? null,
      locations: [...new Set(receiptRows.map((r) => r.location))].sort(),
      receipts: receiptRows,
      history: historyRows,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('Error fetching product FIFO detail:', error);
    return NextResponse.json({ error: 'Failed to load product detail' }, { status: 500 });
  }
}
