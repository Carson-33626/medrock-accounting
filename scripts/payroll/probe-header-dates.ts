/**
 * READ-ONLY: what pay dates exist as built drafts, and how far back does
 * source.payroll_history go? Grounds the "pre-April 2026 batches don't load at
 * the bottom" diagnosis (Barbara 2026-07-20). No writes.
 *   npx tsx scripts/payroll/probe-header-dates.ts
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
  // Matches the app's own pool config (src/lib/rds.ts) — RDS uses an AWS-issued
  // cert chain that isn't in the default Node trust store.
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const headers = await pool.query<{ d: string; entities: string; n: string }>(
    `SELECT to_char(to_date(pay_date, 'MM/DD/YYYY'), 'YYYY-MM-DD') AS d,
            string_agg(DISTINCT entity, ',') AS entities,
            count(*)::text AS n
     FROM accounting.payroll_journal_headers
     GROUP BY 1 ORDER BY 1 DESC`,
  );
  console.log(`\n=== BUILT DRAFTS: ${headers.rowCount} distinct pay dates ===`);
  for (const r of headers.rows) console.log(`  ${r.d}  ${r.entities}  (${r.n} headers)`);

  const src = await pool.query<{ ym: string; n: string; dates: string }>(
    `SELECT to_char(to_date(pay_date, 'MM/DD/YYYY'), 'YYYY-MM') AS ym,
            count(*)::text AS n,
            count(DISTINCT pay_date)::text AS dates
     FROM source.payroll_history
     GROUP BY 1 ORDER BY 1 DESC`,
  );
  console.log(`\n=== SOURCE payroll_history by month: ${src.rowCount} months ===`);
  for (const r of src.rows) console.log(`  ${r.ym}  ${r.n} rows, ${r.dates} pay dates`);

  await pool.end();
}

void main();
