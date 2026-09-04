/**
 * READ-ONLY: what packaging stock was carried INTO 2026?
 *
 * The pump reconciliation lands at ~122,500 units bought in 2026 against 155,647-164,730
 * modelled as consumed once the classifier defects are corrected. If real stock was carried
 * in from 2025 the residual is a drawdown rather than a defect — and that is exactly the
 * §9.2 question about what the March inventory target should be.
 *
 * Run from web/:  npx tsx scripts/_probe-packaging-opening-2026.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface Row {
  location: string;
  lots: number;
  open_lots: number;
  qty_remaining: number | null;
  remaining_value: number | null;
}

async function main(): Promise<void> {
  const pool = getRdsPool();

  // The ledger's own view of packaging on hand at the last month of 2025.
  const { rows } = await pool.query<Row>(
    `SELECT l.location,
            count(*)::int AS lots,
            count(*) FILTER (WHERE l.qty_remaining > 0)::int AS open_lots,
            round(sum(GREATEST(l.qty_remaining, 0))::numeric, 0)::float8 AS qty_remaining,
            round(sum(GREATEST(l.remaining_value, 0))::numeric, 2)::float8 AS remaining_value
     FROM inventory.lot_depletion_ledger l
     JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE p.qb_category = 'Lab Compound Packaging Inventory'
       AND l.as_of_month = '2025-12'
       AND COALESCE(l.pre_floor_collapsed, false) = false
     GROUP BY l.location ORDER BY l.location`,
  );

  console.log('packaging on hand at 2025-12, per the lot ledger:\n');
  let units = 0;
  let value = 0;
  for (const r of rows) {
    units += r.qty_remaining ?? 0;
    value += r.remaining_value ?? 0;
    console.log(
      `  ${r.location.padEnd(20)} ${String(r.lots).padStart(4)} lots  ${String(r.open_lots).padStart(4)} open` +
        `  ${(r.qty_remaining ?? 0).toFixed(0).padStart(9)} units  $${(r.remaining_value ?? 0).toFixed(2).padStart(11)}`,
    );
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${' '.repeat(21)}${units.toFixed(0).padStart(9)} units  $${value.toFixed(2).padStart(11)}`);

  // Does the ledger see ANY 2026 packaging receipts? The pump agent found none.
  const { rows: recv } = await pool.query<{ yr: string; lots: number; units: number }>(
    `SELECT to_char(p.date_received, 'YYYY') AS yr,
            count(*)::int AS lots,
            round(sum(p.qty_received)::numeric, 0)::float8 AS units
     FROM inventory.purchase_lots p
     WHERE p.qb_category = 'Lab Compound Packaging Inventory'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
  );
  console.log('\npackaging RECEIPTS reaching LifeFile, by year:');
  for (const r of recv) {
    console.log(`  ${r.yr ?? '(none)'}  ${String(r.lots).padStart(4)} lots  ${(r.units ?? 0).toFixed(0).padStart(9)} units`);
  }

  console.log(
    '\nreconciliation: ~122,500 pumps bought in 2026 (invoice OCR) + whatever was carried in above,\n' +
      'against 155,647-164,730 modelled as consumed once the classifier defects are corrected.',
  );
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
