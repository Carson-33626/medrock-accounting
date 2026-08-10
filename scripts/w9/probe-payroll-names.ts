/**
 * READ-ONLY: distinct employee names from source.payroll_history (plaintext
 * column) — used to prune employee reimbursement records from the W9 target
 * list. Prints names only; no PII decryption, no writes.
 *   npx tsx scripts/w9/probe-payroll-names.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const connectionString = process.env.RDS_DATABASE_URL;
if (!connectionString) throw new Error('RDS_DATABASE_URL not set');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString, ssl: RDS_SSL });
  const res = await pool.query<{ name: string }>(
    `SELECT DISTINCT name FROM source.payroll_history WHERE name IS NOT NULL ORDER BY name`,
  );
  const out = resolve(__dirname, '..', 'out', 'payroll-names.txt');
  writeFileSync(out, res.rows.map((r) => r.name).join('\n'), 'utf-8');
  console.log(`${res.rowCount} distinct payroll names -> ${out}`);
  await pool.end();
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
