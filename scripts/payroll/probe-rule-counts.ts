/** READ-ONLY: rules per entity, to see how far the seed got. */
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
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL, connectionTimeoutMillis: 30000 });
  try {
    const r = await pool.query<{ entity: string; n: string; act: string }>(
      `SELECT entity, count(*)::text AS n, count(*) FILTER (WHERE active)::text AS act
         FROM accounting.payroll_account_map GROUP BY entity ORDER BY entity`);
    for (const x of r.rows) console.log(`  ${x.entity.padEnd(12)} ${x.n.padStart(5)} rules (${x.act} active)`);
    const f = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounting.payroll_account_map WHERE adp_column='FMLA - EARNING'`);
    console.log(`  FMLA rules: ${f.rows[0].n}`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
