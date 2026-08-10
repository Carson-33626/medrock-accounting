/** READ-ONLY: confirm the Dallas reclass reached the built JE lines, and that both dimensions
 *  exist in MedRock FL's QuickBooks so the post will not throw `unresolved department/class`. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL, connectionTimeoutMillis: 30_000 });
  try {
    const r = await pool.query<{ class_name: string | null; department_name: string | null; n: string; amt: string }>(
      `SELECT l.class_name, l.department_name, count(*)::text AS n, sum(l.amount)::text AS amt
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE h.entity = 'MedRock FL' AND h.kind <> 'allocation'
          AND l.class_name IS NOT NULL
        GROUP BY 1,2 ORDER BY 1,2`);
    console.log('\n=== MedRock FL JE lines carrying a CLASS ===');
    for (const x of r.rows) {
      console.log(`  class=${String(x.class_name).padEnd(16)} dept=${String(x.department_name ?? '(none)').padEnd(18)} ${x.n.padStart(4)} lines  ${money(Number(x.amt))}`);
    }
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
