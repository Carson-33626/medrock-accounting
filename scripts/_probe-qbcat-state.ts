/**
 * READ-ONLY: did the nightly rebuild land the three loader changes?
 *
 *   1. `qb_category` present on lot_depletion_ledger, and populated on OB| receipts
 *   2. device units after the units_per_fill conformance + jar rule
 *
 * Run from web/:  npx tsx scripts/_probe-qbcat-state.ts
 */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';

interface ColRow { column_name: string }
interface CatRow { qb_category: string | null; rows: number; receipts: number }

async function main(): Promise<void> {
  const pool = getRdsPool();

  const cols = await pool.query<ColRow>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='inventory' AND table_name='lot_depletion_ledger'
       AND column_name='qb_category'`,
  );
  console.log(`qb_category column present: ${cols.rows.length > 0 ? 'YES' : 'NO'}`);
  if (cols.rows.length === 0) {
    await pool.end();
    return;
  }

  const cats = await pool.query<CatRow>(
    `SELECT qb_category, count(*)::int AS rows, count(DISTINCT receipt_id)::int AS receipts
     FROM inventory.lot_depletion_ledger
     WHERE receipt_id LIKE 'OB|%'
     GROUP BY qb_category ORDER BY 2 DESC`,
  );
  console.log('\nOB| receipts by qb_category:');
  for (const r of cats.rows) {
    console.log(
      `  ${(r.qb_category ?? '(null)').padEnd(28)} ${String(r.rows).padStart(7)} rows  ${String(r.receipts).padStart(6)} receipts`,
    );
  }

  const all = await pool.query<CatRow>(
    `SELECT qb_category, count(*)::int AS rows, count(DISTINCT receipt_id)::int AS receipts
     FROM inventory.lot_depletion_ledger
     GROUP BY qb_category ORDER BY 2 DESC LIMIT 15`,
  );
  console.log('\nWHOLE ledger by qb_category:');
  for (const r of all.rows) {
    console.log(
      `  ${(r.qb_category ?? '(null)').padEnd(28)} ${String(r.rows).padStart(8)} rows  ${String(r.receipts).padStart(7)} receipts`,
    );
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
