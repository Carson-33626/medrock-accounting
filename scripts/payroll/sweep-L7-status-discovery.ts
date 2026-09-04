/**
 * READ-ONLY (books sweep L7, benefits vs deductions). Schema discovery only, no PII values:
 * distinct `status` and `pay_type` vocabulary in source.payroll_history, so the benefits sweep
 * can detect terminations without guessing column semantics.
 *
 *   npx tsx scripts/payroll/sweep-L7-status-discovery.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  for (const col of ['status', 'pay_type', 'processed_as']) {
    const { rows } = await pool.query<{ v: string; n: string }>(
      `SELECT COALESCE(${col}, '(null)') v, count(*)::text n FROM source.payroll_history GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    );
    console.log(`\n=== ${col} ===`);
    for (const r of rows) console.log(`  ${r.v}: ${r.n}`);
  }
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
