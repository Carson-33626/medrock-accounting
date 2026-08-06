/**
 * Read-only probe: any existing accounting.payroll_account_map rules for
 * 'CHILD PAYMENTS - ER' (e.g. hand-added via the UI) that the seed upsert
 * would collide with? Mirrors the rule-1544 gotcha from the COMPANY LOAN seed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { getRdsPool } = await import('../../src/lib/rds');
  const pool = getRdsPool();
  const res = await pool.query(
    `SELECT id, entity, adp_column, cost_center, account_name, posting_type,
            credit_bucket, is_cogs, memo, active
       FROM accounting.payroll_account_map
      WHERE adp_column = 'CHILD PAYMENTS - ER'
      ORDER BY entity, posting_type`,
  );
  console.log(`rows: ${res.rowCount}`);
  for (const row of res.rows) console.log(JSON.stringify(row));
  await pool.end();
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
