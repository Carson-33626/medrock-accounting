/** READ-ONLY: do we have payroll DRAFTS for 2025, and does the employee map carry any date scope? */
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
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL, connectionTimeoutMillis: 30_000 });
  try {
    const a = await pool.query<{ yr: string; entity: string; n: string; posted: string }>(
      `SELECT to_char(to_date(pay_date,'MM/DD/YYYY'),'YYYY') AS yr, entity, count(*)::text AS n,
              count(*) FILTER (WHERE qb_entry_id IS NOT NULL)::text AS posted
         FROM accounting.payroll_journal_headers WHERE kind <> 'allocation'
        GROUP BY 1,2 ORDER BY 1,2`);
    console.log('\n=== payroll drafts by year / entity (posted = has a qb_entry_id) ===');
    for (const r of a.rows) console.log(`  ${r.yr}  ${r.entity.padEnd(12)} ${r.n.padStart(4)} drafts, ${r.posted} posted`);

    const c = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='accounting' AND table_name='payroll_employee_map' ORDER BY ordinal_position`);
    console.log('\n=== payroll_employee_map columns (is there any date scoping?) ===');
    for (const r of c.rows) console.log(`  ${r.column_name} (${r.data_type})`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
