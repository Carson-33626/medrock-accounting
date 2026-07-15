// web/scripts/payroll/run-memo-migration.ts
// Runs scripts/migrations/alter_payroll_account_map_memo.sql against live RDS (adds the
// nullable `memo` column to accounting.payroll_account_map), then confirms the column list.
// No row data printed. Idempotent (ADD COLUMN IF NOT EXISTS).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const sqlPath = resolve(__dirname, '..', 'migrations', 'alter_payroll_account_map_memo.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(sql);
    console.log('payroll_account_map memo migration applied');
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='accounting' AND table_name='payroll_account_map'
       ORDER BY ordinal_position`,
    );
    console.log('accounting.payroll_account_map columns:', cols.rows.map((r) => r.column_name).join(', '));
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
