/**
 * READ-ONLY: size the Uncoded bucket at 2025-12 (the year-end restatement date
 * Ash chose on 2026-09-14) and explain WHERE it comes from.
 *
 *   1. (location, category) ending value at 2025-12 vs 2026-03 — the same cut
 *      `fetchCategoryLedgerValues` makes.
 *   2. The Uncoded rows at 2025-12: how many have a purchase lot, how many carry
 *      a product_key with a LifeFile id, how many are OB| receipts.
 *   3. Top Uncoded products at 2025-12 by remaining value.
 *
 * Run from web/:  npx tsx scripts/_probe-ye2025-uncoded.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

const CATEGORY_EXPR = `COALESCE(l.qb_category, p.qb_category, 'Uncoded')`;
const NOT_COLLAPSED = `COALESCE(l.pre_floor_collapsed, false) = false`;

interface CellRow {
  as_of_month: string;
  location: string;
  qb_category: string;
  ending_value: number;
  lot_count: number;
}

interface ShapeRow {
  location: string;
  bucket: string;
  lots: number;
  ending_value: number;
}

interface TopRow {
  location: string;
  product_key: string;
  product_name: string | null;
  ndc: string | null;
  is_ob: boolean;
  lots: number;
  ending_value: number;
  last_received: string | null;
}

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }).padStart(16);

async function main(): Promise<void> {
  const pool = getRdsPool();

  const cells = await pool.query<CellRow>(
    `SELECT l.as_of_month,
            l.location,
            ${CATEGORY_EXPR} AS qb_category,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value,
            count(*)::int AS lot_count
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month IN ('2025-12', '2026-03') AND ${NOT_COLLAPSED}
     GROUP BY l.as_of_month, l.location, ${CATEGORY_EXPR}
     ORDER BY l.as_of_month, l.location, qb_category`,
  );
  console.log('\n== (location, category) ending value ==');
  let lastKey = '';
  const totals: Record<string, number> = {};
  const uncoded: Record<string, number> = {};
  for (const r of cells.rows) {
    const key = `${r.as_of_month} ${r.location}`;
    if (key !== lastKey) {
      console.log(`\n${key}`);
      lastKey = key;
    }
    console.log(`  ${r.qb_category.padEnd(34)} ${money(r.ending_value)}  ${String(r.lot_count).padStart(6)} lots`);
    totals[key] = (totals[key] ?? 0) + r.ending_value;
    if (r.qb_category === 'Uncoded') uncoded[key] = (uncoded[key] ?? 0) + r.ending_value;
  }
  console.log('\n== Uncoded share ==');
  for (const key of Object.keys(totals)) {
    const u = uncoded[key] ?? 0;
    const t = totals[key];
    console.log(`  ${key.padEnd(28)} ${money(u)} of ${money(t)}  (${t === 0 ? '0.0' : ((100 * u) / t).toFixed(1)}%)`);
  }

  const shape = await pool.query<ShapeRow>(
    `SELECT l.location,
            CASE
              WHEN l.receipt_id LIKE 'OB|%' THEN 'OB receipt (no purchase lot)'
              WHEN p.receipt_id IS NULL THEN 'no purchase_lots row'
              WHEN p.qb_category IS NULL AND l.qb_category IS NULL THEN 'purchase lot, both categories NULL'
              ELSE 'other'
            END AS bucket,
            count(*)::int AS lots,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = '2025-12' AND ${NOT_COLLAPSED}
       AND ${CATEGORY_EXPR} = 'Uncoded'
     GROUP BY 1, 2 ORDER BY 1, 4 DESC`,
  );
  console.log('\n== 2025-12 Uncoded rows: where they come from ==');
  for (const r of shape.rows) {
    console.log(`  ${r.location.padEnd(20)} ${r.bucket.padEnd(38)} ${String(r.lots).padStart(6)} lots ${money(r.ending_value)}`);
  }

  const top = await pool.query<TopRow>(
    `SELECT l.location,
            l.product_key,
            max(p.product_name) AS product_name,
            max(NULLIF(p.ndc, '')) AS ndc,
            bool_or(l.receipt_id LIKE 'OB|%') AS is_ob,
            count(*)::int AS lots,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value,
            max(p.date_received)::text AS last_received
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = '2025-12' AND ${NOT_COLLAPSED}
       AND ${CATEGORY_EXPR} = 'Uncoded'
     GROUP BY l.location, l.product_key
     ORDER BY ending_value DESC
     LIMIT 40`,
  );
  console.log('\n== 2025-12 top Uncoded products by remaining value ==');
  for (const r of top.rows) {
    console.log(
      `  ${r.location.padEnd(20)} ${(r.product_name ?? r.product_key).slice(0, 44).padEnd(44)} ${(r.ndc ?? '').padEnd(14)} ${r.is_ob ? 'OB ' : '   '} ${String(r.lots).padStart(4)} ${money(r.ending_value)}  ${r.last_received ?? ''}`,
    );
  }

  const distinct = await pool.query<{ location: string; products: number; ending_value: number }>(
    `SELECT l.location, count(DISTINCT l.product_key)::int AS products,
            COALESCE(sum(l.remaining_value), 0)::float8 AS ending_value
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = '2025-12' AND ${NOT_COLLAPSED}
       AND ${CATEGORY_EXPR} = 'Uncoded' AND l.remaining_value > 0
     GROUP BY l.location`,
  );
  console.log('\n== 2025-12 distinct Uncoded products with value > 0 ==');
  for (const r of distinct.rows) {
    console.log(`  ${r.location.padEnd(20)} ${String(r.products).padStart(5)} products ${money(r.ending_value)}`);
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
