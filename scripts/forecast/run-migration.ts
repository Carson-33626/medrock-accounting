// web/scripts/forecast/run-migration.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
async function main(): Promise<void> {
  const sqlPath = resolve(__dirname, '..', 'migrations', 'create_accounting_manual_forecasts.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try { await pool.query(sql); console.log('accounting_manual_forecasts migrated'); } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
