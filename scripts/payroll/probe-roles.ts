/** READ-ONLY: plaintext dimension vocabulary in live source.payroll_history — home_department,
 * location, worker_classification by pay_group. No decryption, no PII values. Informs the mapping model. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    for (const col of ['home_department', 'worker_classification']) {
      const r = await pool.query<{ v: string; n: string }>(
        `SELECT COALESCE(${col},'(null)') v, count(*)::text n FROM source.payroll_history GROUP BY 1 ORDER BY 2 DESC`);
      console.log(`\n=== ${col} ===`);
      for (const x of r.rows) console.log(`  ${x.v}: ${x.n}`);
    }
    // home_department × pay_group crosstab (distinct employees, current period-ish)
    const cross = await pool.query<{ pay_group: string; home_department: string; emps: string }>(
      `SELECT pay_group, COALESCE(home_department,'(null)') home_department, count(DISTINCT position_id)::text emps
       FROM source.payroll_history GROUP BY 1,2 ORDER BY 1, 3 DESC`);
    console.log('\n=== pay_group × home_department (distinct employees) ===');
    for (const x of cross.rows) console.log(`  ${x.pay_group} / ${x.home_department}: ${x.emps}`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
