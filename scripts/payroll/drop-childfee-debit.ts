/**
 * Removes the phantom employer-expense debit for CHILD PAYMENTS - ER, and the old generic-pool
 * credit that the corrected seed replaces with an entity-specific garnishment credit.
 *
 * The seed only UPSERTS, so superseded rows must be deleted explicitly or they keep firing —
 * and a stale Debit here is exactly what left every MedRock FL run $2.00 out of balance.
 * DEFAULT IS A DRY RUN; pass --apply.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const APPLY = process.argv.includes('--apply');
interface R { id: number; entity: string; posting_type: string; account_name: string; active: boolean }
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL, connectionTimeoutMillis: 30_000 });
  try {
    const { rows } = await pool.query<R>(
      `SELECT id, entity, posting_type, account_name, active FROM accounting.payroll_account_map
        WHERE adp_column = 'CHILD PAYMENTS - ER' ORDER BY entity, posting_type`);
    console.log(`\nAll CHILD PAYMENTS - ER rules (${rows.length}):`);
    for (const r of rows) console.log(`  id=${r.id} ${r.active ? 'active  ' : 'inactive'} ${r.entity.padEnd(12)} ${r.posting_type.padEnd(6)} -> ${r.account_name}`);
    // Kill the expense debit, and any credit that is NOT the corrected garnishment-bucket one.
    const doomed = rows.filter((r) => r.posting_type === 'Debit' || r.account_name === 'Payroll Withholdings' && r.entity === 'MedRock FL');
    console.log(`\nTo DELETE (${doomed.length}):`);
    for (const r of doomed) console.log(`  id=${r.id} ${r.entity} ${r.posting_type} -> ${r.account_name}`);
    if (!APPLY) { console.log('\nDry run. --apply to delete.'); return; }
    if (doomed.length > 0) {
      const res = await pool.query(`DELETE FROM accounting.payroll_account_map WHERE id = ANY($1::bigint[])`, [doomed.map((r) => r.id)]);
      console.log(`\ndeleted ${res.rowCount}`);
    }
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
