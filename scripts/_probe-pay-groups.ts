import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{ pay_group: string; kind: string; n: string; posted: string }>(
    `SELECT pay_group, kind, count(*)::text AS n, count(*) FILTER (WHERE status='posted')::text AS posted FROM accounting.payroll_journal_headers WHERE kind IN ('inventory','accrual','reversal') GROUP BY 1,2 ORDER BY 1,2`);
  console.log(JSON.stringify(rows));
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
