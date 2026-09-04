/** READ-ONLY: list source.payroll_history columns matching PTO/garnishment/reimbursement/PR keywords.
 *    npx tsx scripts/payroll/probe-R-FL-schema-check.ts */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();
  const res = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'source' AND table_name = 'payroll_history'
     ORDER BY column_name`
  );
  const cols = res.rows.map((r) => r.column_name);
  console.log(`Total columns: ${cols.length}`);
  const keywords = ['pto', 'garnish', 'reimburse', 'puerto', 'p_r', 'pr_', '401', 'vacation', 'sick'];
  for (const kw of keywords) {
    const hits = cols.filter((c) => c.toLowerCase().includes(kw));
    if (hits.length) console.log(`\n[${kw}] ${hits.length} matches:`);
    for (const h of hits) console.log(`  ${h}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
