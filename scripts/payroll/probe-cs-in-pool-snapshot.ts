/**
 * READ-ONLY: do the stored `payroll_eom_runs.pool` snapshots contain the CS pool lines?
 *
 * Decides whether a CS ALLO entry's basis sheet can be rebuilt at all. The month-end
 * generate excludes the CS pool for CS-Allo months (the double-move hard rule), so the
 * snapshot it writes may not carry the very lines a CS ALLO entry was built from.
 *
 * Run from web/:  npx tsx scripts/payroll/probe-cs-in-pool-snapshot.ts
 */
import './load-env-vercel-first';
import { getEomRun } from '../../src/lib/payroll/eom-store';
import { isCsPoolLine, type PoolLine } from '../../src/lib/payroll/qb-pool';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

function asPoolLines(value: unknown): PoolLine[] {
  return Array.isArray(value) ? (value as PoolLine[]) : [];
}

async function main(): Promise<void> {
  for (const month of MONTHS) {
    const run = await getEomRun(month);
    if (!run) {
      console.log(`${month}  no snapshot`);
      continue;
    }
    const pool = asPoolLines(run.pool);
    const cs = pool.filter(isCsPoolLine);
    const csCents = cs.reduce((s, l) => s + Math.round((l.amount ?? 0) * 100), 0);
    console.log(
      `${month}  pool ${String(pool.length).padStart(4)} lines  |  CS lines ${String(cs.length).padStart(4)}` +
        `  totalling ${(csCents / 100).toFixed(2)}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
