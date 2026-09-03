// READ-ONLY: can Florida's Opening Balance lots be attributed to a real category?
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
import { PRODUCT_NAMES_CTE, RESOLVED_PRODUCT_NAME } from '../src/lib/inventory-sql';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{
    receipt_id: string; product_key: string; product_name: string | null;
    remaining: number | null; qty_remaining: number | null; has_lot: boolean;
    sibling_category: string | null;
  }>(
    `WITH ${PRODUCT_NAMES_CTE},
     ob AS (
       SELECT l.receipt_id, l.product_key, l.remaining_value, l.qty_remaining,
              (p.receipt_id IS NOT NULL) AS has_lot
       FROM inventory.lot_depletion_ledger l
       LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
       WHERE l.as_of_month = '2026-03' AND l.location = 'MedRock Florida'
         AND COALESCE(p.qb_category, 'Opening Balance') = 'Opening Balance'
         AND COALESCE(l.pre_floor_collapsed, false) = false
         AND l.qty_remaining > 0
     )
     SELECT ob.receipt_id, ob.product_key,
            COALESCE(pn.name, CASE WHEN ob.product_key LIKE 'name:%' THEN upper(substr(ob.product_key, 6)) END) AS product_name,
            ob.remaining_value::float8 AS remaining, ob.qty_remaining::float8 AS qty_remaining, ob.has_lot,
            (SELECT max(p2.qb_category) FROM inventory.purchase_lots p2
              WHERE p2.qb_category IS NOT NULL
                AND (p2.ndc_norm = NULLIF(ob.product_key, '')
                  OR upper(p2.product_name) = upper(COALESCE(pn.name,
                       CASE WHEN ob.product_key LIKE 'name:%' THEN substr(ob.product_key, 6) END)))
            ) AS sibling_category
     FROM ob LEFT JOIN product_names pn ON pn.key = ob.product_key
     ORDER BY ob.remaining_value DESC NULLS LAST`);

  console.log(`FL Opening Balance lots still on hand at 2026-03: ${rows.length}\n`);
  let attributable = 0, attrValue = 0, orphanValue = 0;
  for (const r of rows) {
    if (r.sibling_category) { attributable += 1; attrValue += r.remaining ?? 0; }
    else orphanValue += r.remaining ?? 0;
    console.log(
      `  ${(r.product_name ?? r.product_key).slice(0, 44).padEnd(44)} ` +
      `${(r.remaining ?? 0).toFixed(2).padStart(10)}  qty ${(r.qty_remaining ?? 0).toFixed(0).padStart(6)}  ` +
      `${r.has_lot ? 'has purchase_lot' : 'NO purchase_lot '}  -> ${r.sibling_category ?? '(no sibling category)'}`);
  }
  console.log(`\n${attributable}/${rows.length} lots have a sibling product with a real category.`);
  console.log(`  attributable value: ${attrValue.toFixed(2)}   unattributable: ${orphanValue.toFixed(2)}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
