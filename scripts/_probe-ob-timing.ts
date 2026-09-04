import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
async function main(): Promise<void> {
  const pool = getRdsPool();
  const CTE = `WITH product_category AS (
      SELECT l.product_key, mode() WITHIN GROUP (ORDER BY p.qb_category) AS category
      FROM inventory.lot_depletion_ledger l
      JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
      WHERE p.qb_category IS NOT NULL GROUP BY l.product_key)`;
  const t0 = Date.now();
  const a = await pool.query<{ n: string }>(`${CTE} SELECT count(*)::text AS n FROM product_category`);
  console.log(`product_category CTE alone: ${a.rows[0].n} keys in ${Date.now() - t0} ms`);

  const t1 = Date.now();
  await pool.query(
    `${CTE}
     SELECT l.as_of_month, l.location,
            COALESCE(p.qb_category, pc.category, 'Opening Balance') AS qb_category,
            sum(l.remaining_value) AS v
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     LEFT JOIN product_category pc ON pc.product_key = l.product_key
     WHERE COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY 1,2,3`);
  console.log(`full category series WITH resolution: ${Date.now() - t1} ms`);

  const t2 = Date.now();
  await pool.query(
    `SELECT l.as_of_month, l.location, COALESCE(p.qb_category, 'Opening Balance') AS qb_category,
            sum(l.remaining_value) AS v
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY 1,2,3`);
  console.log(`full category series TODAY (no resolution): ${Date.now() - t2} ms`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
