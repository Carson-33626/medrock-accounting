/**
 * Does the as-of page's source (inventory.fifo_valuation_summary) tie to the
 * close JE's source (inventory.lot_depletion_ledger) at (location, category)?
 *
 * The whole point of putting both screens on "one method" is that they foot to
 * each other. They are two different TABLES, so that has to be proven, not
 * assumed — if this prints a variance the single-number claim is false.
 *
 * Read-only. Goes through getRdsPool() for the pinned AWS CA in src/lib/rds-ssl.ts.
 *
 * Usage: npx tsx --env-file=.env.local scripts/inventory/verify-summary-vs-ledger.ts 2026-03
 */
import { getRdsPool } from '../../src/lib/rds';

interface Row {
  location: string;
  cat: string;
  v: number;
}

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const key = (r: Row): string => `${r.location}|${r.cat}`;

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-03';
  const pool = getRdsPool();

  // The close's grain, verbatim from fetchCategoryLedgerValues.
  const ledger = await pool.query<Row>(
    `SELECT l.location, COALESCE(p.qb_category,'Opening Balance') AS cat,
            COALESCE(sum(l.remaining_value), 0)::float8 AS v
     FROM inventory.lot_depletion_ledger l
     LEFT JOIN inventory.purchase_lots p ON p.receipt_id = l.receipt_id
     WHERE l.as_of_month = $1
     GROUP BY 1, 2`,
    [month],
  );

  // The as-of page's grain, via the summary table the /api/inventory/summary route reads.
  // basis IS NOT OPTIONAL here: the table holds an accrual AND a cash row per
  // (month, location, category), so omitting it silently doubles every figure.
  const summary = await pool.query<Row>(
    `SELECT location, qb_category AS cat,
            COALESCE(sum(on_hand_value_fifo), 0)::float8 AS v
     FROM inventory.fifo_valuation_summary
     WHERE as_of_month = $1 AND basis = 'accrual'
     GROUP BY 1, 2`,
    [month],
  );

  const l = new Map(ledger.rows.map((r) => [key(r), r.v]));
  const s = new Map(summary.rows.map((r) => [key(r), r.v]));
  const keys = [...new Set([...l.keys(), ...s.keys()])].sort();

  let worst = 0;
  for (const k of keys) {
    const a = l.get(k) ?? 0;
    const b = s.get(k) ?? 0;
    const d = b - a;
    worst = Math.max(worst, Math.abs(d));
    const flag = Math.abs(d) > 0.01 ? '  <-- VARIANCE' : '';
    console.log(`${k.padEnd(46)} ledger ${usd(a).padStart(16)}  summary ${usd(b).padStart(16)}${flag}`);
  }

  const lt = [...l.values()].reduce((x, y) => x + y, 0);
  const st = [...s.values()].reduce((x, y) => x + y, 0);
  console.log('');
  console.log(`TOTAL   ledger ${usd(lt)}   summary ${usd(st)}   diff ${usd(st - lt)}`);
  console.log(`worst per-row variance: ${usd(worst)}`);
  console.log(Math.abs(st - lt) < 0.01 && worst < 0.01 ? 'TIES ✓' : 'DOES NOT TIE ✗');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
