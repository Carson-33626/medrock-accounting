/**
 * READ-ONLY: full detail on every COMPANY LOAN rule in RDS — including the
 * pre-existing FL Debit rule that did NOT come from the seed. Shows the natural
 * key columns + timestamps so we can tell who/what created it and whether it
 * conflicts with the seeded Credit rule.
 *   npx tsx scripts/payroll/check-loan-rule.ts
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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='accounting' AND table_name='payroll_account_map' ORDER BY ordinal_position`,
  );
  console.log('columns:', cols.rows.map((c) => c.column_name).join(', '));

  const { rows } = await pool.query(
    `SELECT * FROM accounting.payroll_account_map
     WHERE adp_column = 'COMPANY LOAN - EE - PRINCIPAL POST-TAX'
     ORDER BY entity, posting_type`,
  );
  console.log(`\nCOMPANY LOAN rules: ${rows.length}`);
  for (const r of rows) console.log(' ', JSON.stringify(r));

  // Are there other columns with the same double-mapping shape (a UI-authored rule
  // sitting alongside a seeded one)? Same column+entity+cost_center, both directions.
  const dupes = await pool.query<{ entity: string; adp_column: string; cost_center: string; dirs: string }>(
    `SELECT entity, adp_column, cost_center, string_agg(DISTINCT posting_type, '+') AS dirs
     FROM accounting.payroll_account_map
     WHERE active = true AND cost_center = '*'
     GROUP BY 1,2,3
     HAVING count(DISTINCT posting_type) > 1
     ORDER BY 2,1`,
  );
  console.log(`\nOther '*' columns mapped in BOTH directions: ${dupes.rowCount}`);
  for (const d of dupes.rows) console.log(`  ${d.entity.padEnd(12)} ${d.adp_column}  [${d.dirs}]`);

  await pool.end();
}

void main();
