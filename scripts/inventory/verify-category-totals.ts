/**
 * One-off check: category totals straight from RDS, to compare against what
 * /api/inventory/monthly-close reports. Goes through getRdsPool() so it uses the
 * pinned AWS CA in src/lib/rds-ssl.ts — never hand-roll a Pool with
 * `rejectUnauthorized: false` against this database.
 *
 * Usage: npx tsx --env-file=.env.local scripts/inventory/verify-category-totals.ts 2026-03
 */
import { getRdsPool } from '../../src/lib/rds';

interface Row {
  location: string;
  cat: string;
  v: number;
  lots: number;
}

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const { rows } = await getRdsPool().query<Row>(
    // COALESCE on the sum mirrors fetchCategoryLedgerValues and is load-bearing:
    // TX's 'Uncoded' group in 2026-03 has every remaining_value NULL, so a bare
    // sum() returns NULL rather than 0 and NaNs the whole downstream calculation.
    `SELECT l.location, COALESCE(p.qb_category,'Opening Balance') AS cat,
            COALESCE(sum(l.remaining_value), 0)::float8 AS v, count(*)::int AS lots
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC`,
    [month],
  );

  const byLocation = new Map<string, number>();
  for (const r of rows) {
    console.log(`${r.location} | ${r.cat} | ${r.v.toFixed(2)} | ${r.lots} lots`);
    byLocation.set(r.location, (byLocation.get(r.location) ?? 0) + r.v);
  }
  console.log('');
  for (const [loc, total] of byLocation) console.log(`SUBTOTAL ${loc} ${total.toFixed(2)}`);
  console.log('TOTAL', rows.reduce((s, r) => s + r.v, 0).toFixed(2));
}

// Explicit both ways: `void main().then(() => process.exit(0))` turns a throw
// into an unhandled rejection and leaves the exit code to chance, which makes
// this unusable from a check script.
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
