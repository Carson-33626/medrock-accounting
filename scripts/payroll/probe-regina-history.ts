/** READ-ONLY: does Regina appear on the FL payroll under an older position id, before the TX
 *  pay group opened on 2025-11-07? Searches by surname and given name across EVERY pay group and
 *  date, since a rehire or an entity move issues a NEW position_id. */
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
    const q = await pool.query<{ position_id: string; name: string; pay_group: string; home_department: string | null; location: string | null; status: string | null; first: string; last: string; dates: string }>(
      `SELECT position_id, name, pay_group, home_department, location, status,
              min(to_date(pay_date,'MM/DD/YYYY'))::text AS first,
              max(to_date(pay_date,'MM/DD/YYYY'))::text AS last,
              count(DISTINCT pay_date)::text AS dates
         FROM source.payroll_history
        WHERE name ILIKE '%regina%' OR name ILIKE '%hofmann%'
        GROUP BY position_id, name, pay_group, home_department, location, status
        ORDER BY first`);
    console.log(`\n=== every row matching "regina" or "hofmann", all pay groups, all dates — ${q.rows.length} ===`);
    for (const r of q.rows) {
      console.log(`  ${r.name.padEnd(28)} pos ${r.position_id}  ${r.pay_group.padEnd(6)} ${String(r.home_department ?? '').padEnd(22)} loc=${r.location ?? ''}`);
      console.log(`      status=${r.status ?? ''}  ${r.first} .. ${r.last}  (${r.dates} pay dates)`);
    }
    // Also: everyone on MRFL whose PHARM role ended right as MRTX opened — a transfer signature.
    const t = await pool.query<{ name: string; position_id: string; last: string; dates: string }>(
      `SELECT name, position_id, max(to_date(pay_date,'MM/DD/YYYY'))::text AS last, count(*)::text AS dates
         FROM source.payroll_history WHERE pay_group = 'MRFL'
        GROUP BY name, position_id
       HAVING max(to_date(pay_date,'MM/DD/YYYY')) BETWEEN '2025-09-01' AND '2025-12-31'
        ORDER BY last`);
    console.log(`\n=== MRFL people whose LAST FL pay date falls Sep-Dec 2025 (transfer window) — ${t.rows.length} ===`);
    for (const r of t.rows) console.log(`  ${r.name.padEnd(30)} pos ${r.position_id}  last FL pay ${r.last}  (${r.dates} rows)`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
