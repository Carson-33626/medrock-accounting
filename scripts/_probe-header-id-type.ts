import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='accounting' AND table_name='payroll_journal_headers' AND column_name='id'`);
  console.log(rows);
  const r = await pool.query<{ id: unknown }>(`SELECT id FROM accounting.payroll_journal_headers WHERE pay_group = 'LAB ACCRUAL' OR pay_group ILIKE '%lab%' LIMIT 1`);
  console.log('runtime typeof id:', r.rows[0] ? typeof r.rows[0].id : '(no lab rows)', r.rows[0]);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
