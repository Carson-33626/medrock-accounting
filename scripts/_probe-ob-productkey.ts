// READ-ONLY: do Opening Balance lots share a product_key with coded lots?
// product_key lives on the LEDGER (purchase_lots has none), so a map built from
// coded ledger rows can carry a category onto the OB rows of the same product.
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{
    location: string; ob_lots: number; matched: number;
    ob_value: number; matched_value: number;
  }>(
    `WITH product_category AS (
       SELECT l.product_key, mode() WITHIN GROUP (ORDER BY p.qb_category) AS category
       FROM inventory.lot_depletion_ledger l
       JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       WHERE p.qb_category IS NOT NULL
       GROUP BY l.product_key
     ),
     ob AS (
       SELECT l.location, l.product_key, l.remaining_value
       FROM inventory.lot_depletion_ledger l
       LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       WHERE l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
         AND COALESCE(l.pre_floor_collapsed, false) = false
         AND p.receipt_id IS NULL
     )
     SELECT ob.location,
            count(*)::int AS ob_lots,
            count(pc.category)::int AS matched,
            round(sum(ob.remaining_value)::numeric, 2)::float8 AS ob_value,
            round(sum(CASE WHEN pc.category IS NOT NULL THEN ob.remaining_value ELSE 0 END)::numeric, 2)::float8 AS matched_value
     FROM ob LEFT JOIN product_category pc ON pc.product_key = ob.product_key
     GROUP BY ob.location ORDER BY ob.location`);

  console.log('Opening-balance lots at the latest ledger month, matched by product_key:');
  for (const r of rows) {
    const pct = r.ob_lots === 0 ? 0 : Math.round((r.matched / r.ob_lots) * 100);
    console.log(
      `  ${r.location.padEnd(20)} ${String(r.ob_lots).padStart(5)} OB lots  ${String(r.matched).padStart(5)} matched (${pct}%)` +
      `  value ${(r.ob_value ?? 0).toFixed(2).padStart(12)}  of which matched ${(r.matched_value ?? 0).toFixed(2).padStart(12)}`);
  }

  const { rows: cats } = await pool.query<{ location: string; category: string; lots: number; value: number }>(
    `WITH product_category AS (
       SELECT l.product_key, mode() WITHIN GROUP (ORDER BY p.qb_category) AS category
       FROM inventory.lot_depletion_ledger l
       JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       WHERE p.qb_category IS NOT NULL GROUP BY l.product_key
     )
     SELECT l.location, COALESCE(pc.category, '(still unresolved)') AS category,
            count(*)::int AS lots, round(sum(l.remaining_value)::numeric, 2)::float8 AS value
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     LEFT JOIN product_category pc ON pc.product_key = l.product_key
     WHERE l.as_of_month = (SELECT max(as_of_month) FROM inventory.lot_depletion_ledger)
       AND COALESCE(l.pre_floor_collapsed, false) = false
       AND p.receipt_id IS NULL AND l.remaining_value > 0
     GROUP BY 1, 2 ORDER BY 1, 4 DESC`);
  console.log('\nwhere the ON-HAND opening balance would land:');
  for (const c of cats) {
    console.log(`  ${c.location.padEnd(20)} ${c.category.padEnd(34)} ${String(c.lots).padStart(4)} lots  ${(c.value ?? 0).toFixed(2).padStart(12)}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
