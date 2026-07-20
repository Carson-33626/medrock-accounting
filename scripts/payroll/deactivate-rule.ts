/**
 * Deactivate a single account-map rule by surrogate id (reversible — sets
 * active=false, never deletes). Preview by default; --apply to write.
 *   npx tsx scripts/payroll/deactivate-rule.ts 1544
 *   npx tsx scripts/payroll/deactivate-rule.ts 1544 --apply
 *
 * Used 2026-07-20 for FL id 1544 (COMPANY LOAN -> Debit Payroll Withholdings,
 * hand-added via the UI on 2026-07-16), which conflicted with the seeded
 * Credit -> Employee Advances rule and would have offset the FL residual with a
 * bogus debit instead of explaining it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const connectionString = process.env.RDS_DATABASE_URL;
if (!connectionString) throw new Error('RDS_DATABASE_URL not set');

const idArg = process.argv[2];
const apply = process.argv.includes('--apply');
if (!idArg || !/^\d+$/.test(idArg)) throw new Error('usage: deactivate-rule.ts <id> [--apply]');
const id = Number(idArg);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const before = await pool.query(`SELECT * FROM accounting.payroll_account_map WHERE id = $1`, [id]);
  if (before.rowCount === 0) {
    console.log(`No rule with id ${id}.`);
    await pool.end();
    return;
  }
  console.log('BEFORE:', JSON.stringify(before.rows[0]));

  if (!apply) {
    console.log('\n(preview — pass --apply to set active=false)');
    await pool.end();
    return;
  }

  const after = await pool.query(
    `UPDATE accounting.payroll_account_map
     SET active = false, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  console.log('AFTER: ', JSON.stringify(after.rows[0]));
  console.log('\nReversible: UPDATE accounting.payroll_account_map SET active = true WHERE id = ' + id + ';');
  await pool.end();
}

void main();
