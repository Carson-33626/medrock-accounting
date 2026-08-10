/** READ-ONLY: what depends on a payroll header, before deleting any 2025 drafts. */
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
    const fk = await pool.query<{ table_name: string; constraint_name: string; column_name: string; delete_rule: string }>(
      `SELECT tc.table_name, tc.constraint_name, kcu.column_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='payroll_journal_headers'`);
    console.log('\n=== things that reference payroll_journal_headers ===');
    for (const r of fk.rows) console.log(`  ${r.table_name}.${r.column_name}  (${r.constraint_name})  ON DELETE ${r.delete_rule}`);

    const c = await pool.query<{ kind: string; n: string; lines: string; posted: string }>(
      `SELECT h.kind, count(DISTINCT h.id)::text AS n, count(l.id)::text AS lines,
              count(DISTINCT h.id) FILTER (WHERE h.qb_entry_id IS NOT NULL)::text AS posted
         FROM accounting.payroll_journal_headers h
         LEFT JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
        WHERE to_date(h.pay_date,'MM/DD/YYYY') BETWEEN '2025-01-01' AND '2025-12-31'
        GROUP BY h.kind`);
    console.log('\n=== 2025 headers by kind ===');
    for (const r of c.rows) console.log(`  kind=${r.kind.padEnd(12)} ${r.n} headers, ${r.lines} lines, ${r.posted} POSTED`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
