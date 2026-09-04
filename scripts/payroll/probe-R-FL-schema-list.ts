/** READ-ONLY: list ALL source.payroll_history columns and a sample decrypted row's field-name shape.
 *    npx tsx scripts/payroll/probe-R-FL-schema-list.ts */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const res = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'source' AND table_name = 'payroll_history'
     ORDER BY ordinal_position`
  );
  for (const r of res.rows) console.log(`${r.column_name}  (${r.data_type})`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
