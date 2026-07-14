// READ-ONLY: how many account-map rules have a memo set, per entity. Confirms how far the
// re-seed got (idempotent → safe to re-run to finish) and that RDS is reachable via a direct pool.
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
    const { rows } = await pool.query<{ entity: string; total: string; with_memo: string }>(
      `SELECT entity, count(*) AS total, count(memo) AS with_memo
       FROM accounting.payroll_account_map WHERE active
       GROUP BY entity ORDER BY entity`,
    );
    for (const r of rows) console.log(`  ${r.entity.padEnd(12)} total=${r.total.padStart(4)}  with_memo=${r.with_memo.padStart(4)}`);
    const sample = await pool.query<{ cost_center: string; account_name: string; memo: string | null }>(
      `SELECT cost_center, account_name, memo FROM accounting.payroll_account_map
       WHERE active AND memo IS NOT NULL AND entity='MedRock FL' ORDER BY cost_center LIMIT 8`,
    );
    console.log('\n  sample FL memos:');
    for (const s of sample.rows) console.log(`    ${s.cost_center.padEnd(7)} ${(s.memo ?? '').padEnd(22)} ${s.account_name}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
