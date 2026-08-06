/** READ-ONLY: are the PTHOLIDAY column + Lockwood marketer saves actually persisting as rules? */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
for (const f of ['.env.local']) {
  try { const t = readFileSync(resolve(__dirname, '..', '..', f), 'utf-8');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch { /* optional */ }
}
async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();

  const pth = await pool.query(
    `SELECT entity, cost_center, account_name, posting_type, active, memo
     FROM accounting.payroll_account_map WHERE adp_column ILIKE 'PTHOLIDAY%' ORDER BY entity, cost_center`);
  console.log(`=== account_map rules for PTHOLIDAY* (${pth.rowCount} rows) ===`);
  for (const r of pth.rows) console.log(r);

  const lock = await pool.query(
    `SELECT entity, position_id, department_name, class_name, cogs_override, active
     FROM accounting.payroll_employee_map WHERE position_id='000184' ORDER BY entity`);
  console.log(`\n=== employee_map rules for Lockwood position 000184 (${lock.rowCount} rows) ===`);
  for (const r of lock.rows) console.log(r);

  // Also: is there any 'PTHOLIDAY - EARNING' vs a slightly different string in the source vocab?
  const cols = await pool.query(
    `SELECT DISTINCT jsonb_object_keys(sensitive_encrypted::jsonb) FROM source.payroll_history LIMIT 0`).catch(() => null);
  void cols;
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
