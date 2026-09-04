/**
 * READ-ONLY probe: 2026 packaging RECEIPTS (actual purchased UNITS) in RDS.
 * The units-vs-units denominator for the pump reconciliation.
 *
 * Run from web/:  npx tsx scripts/_probe-pump-receipts.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface ColRow { readonly column_name: string; readonly data_type: string }
interface LotRow {
  readonly location: string | null;
  readonly product_name: string | null;
  readonly units: string | null;
  readonly cost: string | null;
  readonly d0: string | null;
  readonly d1: string | null;
}

async function main(): Promise<void> {
  const pool = getRdsPool();

  const { rows: cols } = await pool.query<ColRow>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='inventory' AND table_name='purchase_lots' ORDER BY ordinal_position`,
  );
  console.log('### inventory.purchase_lots columns');
  for (const c of cols) console.log(`  ${c.column_name} : ${c.data_type}`);

  const dateCol = cols.find((c): boolean => /date/.test(c.column_name))?.column_name ?? '';
  console.log(`\nusing date column: ${dateCol}\n`);

  const sql = `
    SELECT p.location,
           p.product_name,
           sum(p.qty_received)::text AS units,
           sum(p.total_cost)::text   AS cost,
           min(p."${dateCol}")::text AS d0,
           max(p."${dateCol}")::text AS d1
    FROM inventory.purchase_lots p
    WHERE p.qb_category = 'Lab Compound Packaging Inventory'
      AND p.qty_received > 0
      AND p."${dateCol}" >= DATE '2026-01-01'
    GROUP BY 1, 2
    ORDER BY 3 DESC`;
  const { rows } = await pool.query<LotRow>(sql);

  console.log('### 2026 packaging receipts (all locations)');
  let pumpUnits = 0;
  let pumpCost = 0;
  let allUnits = 0;
  for (const r of rows) {
    const name = (r.product_name ?? '').toUpperCase();
    const units = Number(r.units ?? 0);
    const cost = Number(r.cost ?? 0);
    const isPump = /PUMP/.test(name) && !/FOAM/.test(name);
    allUnits += units;
    if (isPump) { pumpUnits += units; pumpCost += cost; }
    console.log(
      `  ${isPump ? 'PUMP ' : '     '}${(r.location ?? '').padEnd(20)}${String(Math.round(units)).padStart(8)} u ` +
      `$${cost.toFixed(2).padStart(11)}  ${r.d0}..${r.d1}  ${r.product_name}`,
    );
  }
  console.log(`\n  2026 packaging units received: ${Math.round(allUnits)}`);
  console.log(`  of which PUMPS: ${Math.round(pumpUnits)} units, $${pumpCost.toFixed(2)}` +
    (pumpUnits > 0 ? ` = $${(pumpCost / pumpUnits).toFixed(4)}/unit` : ''));

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
