/** Read-only: confirm basis='cash' rows landed in fifo_valuation_summary. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query(
    `SELECT basis, count(*)::int AS rows,
            round(sum(CASE WHEN as_of_month = '2026-06' THEN on_hand_value_fifo ELSE 0 END)) AS june_on_hand,
            round(sum(CASE WHEN as_of_month = '2026-06' THEN COALESCE(cash_estimated_value, 0) ELSE 0 END)) AS june_estimated
     FROM inventory.fifo_valuation_summary
     GROUP BY basis ORDER BY basis`,
  );
  console.table(r.rows);
  await pool.end();
}

void main();
