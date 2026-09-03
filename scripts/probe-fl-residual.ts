/**
 * READ-ONLY: what is actually in Florida's residual buckets?
 *
 * The close warns: "MedRock Florida: Opening Balance, Uncoded have no QuickBooks category
 * account — posted to the parent Inventory Asset / Cost of Goods Sold as ONE combined
 * residual line (assign drug codes to clear)".
 *
 * The advice "assign drug codes to clear" only works for Uncoded. Opening Balance lots have
 * no `purchase_lots` row at all — they are pre-history pseudo-receipts (`OB|…`), so there is
 * no product to code. This measures both, so the fix can be aimed at the right one.
 *
 * Run from web/:  npx tsx scripts/probe-fl-residual.ts [YYYY-MM]
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

const RESIDUAL = ['Opening Balance', 'Uncoded'];

interface BucketRow {
  location: string;
  qb_category: string;
  lots: number;
  open_lots: number;
  remaining: number;
  consumed_value: number;
}

interface ProductRow {
  product_key: string;
  product_name: string | null;
  ndc: string | null;
  lots: number;
  remaining: number;
  has_lifefile_id: boolean;
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const month =
    process.argv[2] ??
    (await pool.query<{ m: string }>(`SELECT max(as_of_month) AS m FROM inventory.lot_depletion_ledger`))
      .rows[0].m;

  console.log(`as of ${month}\n`);

  const { rows: buckets } = await pool.query<BucketRow>(
    `SELECT l.location,
            COALESCE(p.qb_category, 'Opening Balance') AS qb_category,
            count(*)::int AS lots,
            count(*) FILTER (WHERE l.qty_remaining > 0)::int AS open_lots,
            round(sum(l.remaining_value)::numeric, 2)::float8 AS remaining,
            round(sum(l.qty_consumed * COALESCE(p.unit_cost, 0))::numeric, 2)::float8 AS consumed_value
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1
       AND COALESCE(l.pre_floor_collapsed, false) = false
       AND COALESCE(p.qb_category, 'Opening Balance') = ANY($2::text[])
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [month, RESIDUAL],
  );

  console.log('residual buckets by location:');
  for (const b of buckets) {
    console.log(
      `  ${b.location.padEnd(20)} ${b.qb_category.padEnd(16)} ${String(b.lots).padStart(5)} lots` +
        `  ${String(b.open_lots).padStart(5)} open  on-hand ${b.remaining.toFixed(2).padStart(12)}` +
        `  consumed ${b.consumed_value.toFixed(2).padStart(10)}`,
    );
  }

  // Uncoded is the only bucket "assign drug codes" can clear. Who is in it, in FL?
  const { rows: products } = await pool.query<ProductRow>(
    `SELECT l.product_key,
            max(p.product_name) AS product_name,
            max(NULLIF(p.ndc, '')) AS ndc,
            count(*)::int AS lots,
            round(sum(l.remaining_value)::numeric, 2)::float8 AS remaining,
            bool_or(p.lifefile_id IS NOT NULL) AS has_lifefile_id
     FROM inventory.lot_depletion_ledger l
     JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1
       AND l.location = 'MedRock Florida'
       AND COALESCE(p.qb_category, 'Opening Balance') = 'Uncoded'
       AND COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY 1 ORDER BY 5 DESC NULLS LAST`,
    [month],
  );

  console.log(`\nFlorida 'Uncoded' products: ${products.length}`);
  for (const p of products.slice(0, 40)) {
    console.log(
      `  ${(p.product_name ?? p.product_key).slice(0, 48).padEnd(48)} ${(p.ndc ?? '—').padEnd(14)}` +
        ` ${String(p.lots).padStart(3)} lots  ${(p.remaining ?? 0).toFixed(2).padStart(11)}` +
        `  ${p.has_lifefile_id ? 'has lifefile_id' : 'NO lifefile_id'}`,
    );
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
