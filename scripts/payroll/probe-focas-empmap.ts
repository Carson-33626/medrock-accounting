/** READ-ONLY: what department/class would FOCAS payroll lines reference at post time? */
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
    const a = await pool.query<{ entity: string; n: string; depts: string[]; classes: string[] }>(
      `SELECT entity, count(*)::text AS n,
              array_agg(DISTINCT COALESCE(department_name,'(null)')) AS depts,
              array_agg(DISTINCT COALESCE(class_name,'(null)')) AS classes
         FROM accounting.payroll_employee_map GROUP BY entity ORDER BY entity`);
    console.log('\n=== payroll_employee_map by entity ===');
    for (const r of a.rows) {
      console.log(`\n  ${r.entity}: ${r.n} rows`);
      console.log(`    departments: ${r.depts.sort().join(' | ')}`);
      console.log(`    classes:     ${r.classes.sort().join(' | ')}`);
    }
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
