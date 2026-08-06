// One-off: deactivate the corrupt account-map rule with cost_center '*PHARM' (a UI free-text
// footgun: default '*' + typed 'PHARM'). It matched neither the row's cost center nor '*', so it
// never resolved and kept the column re-flagging. Reversible: SET active=false (not DELETE).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const res = await pool.query(
      `UPDATE accounting.payroll_account_map SET active=false, updated_at=now()
       WHERE cost_center='*PHARM' AND active=true
       RETURNING id, entity, adp_column, cost_center, account_name`,
    );
    console.log(`deactivated ${res.rowCount} rule(s):`);
    for (const r of res.rows) console.log(r);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
