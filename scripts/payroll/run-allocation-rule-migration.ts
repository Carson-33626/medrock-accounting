// web/scripts/payroll/run-allocation-rule-migration.ts
// Runs scripts/migrations/create_payroll_allocation_rule.sql against live RDS, then confirms
// the table's columns (no row data). Env from .env.local.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const sql = readFileSync(resolve(__dirname, '..', 'migrations', 'create_payroll_allocation_rule.sql'), 'utf8');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(sql);
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='accounting' AND table_name='payroll_allocation_rule' ORDER BY ordinal_position`,
    );
    console.log('accounting.payroll_allocation_rule columns:', cols.rows.map((r) => r.column_name).join(', '));
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
