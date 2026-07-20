/**
 * READ-ONLY: status census of existing drafts + what saveDraft would collide with,
 * before a bulk historical rebuild (Jan 2026 →). Flags any approved/posted header
 * that a rebuild must NOT clobber, and lists source pay dates with no draft yet.
 *   npx tsx scripts/payroll/probe-draft-status.ts
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
  // Matches the app's own pool config (src/lib/rds.ts).
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const status = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n
     FROM accounting.payroll_journal_headers GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log('=== HEADER STATUS CENSUS ===');
  for (const r of status.rows) console.log(`  ${r.status.padEnd(14)} ${r.n}`);

  const risky = await pool.query<{ d: string; entity: string; status: string; qb: string | null }>(
    `SELECT to_char(to_date(pay_date,'MM/DD/YYYY'),'YYYY-MM-DD') AS d,
            entity, status, qb_entry_id AS qb
     FROM accounting.payroll_journal_headers
     WHERE status NOT IN ('draft','needs_review') OR qb_entry_id IS NOT NULL
     ORDER BY 1 DESC`,
  );
  console.log(`\n=== NOT-SAFE-TO-REBUILD (approved/posted or has a QB entry id): ${risky.rowCount} ===`);
  for (const r of risky.rows) console.log(`  ${r.d}  ${r.entity}  ${r.status}  qb=${r.qb ?? '-'}`);
  if (risky.rowCount === 0) console.log('  none — every header is an unposted draft.');

  const missing = await pool.query<{ d: string; groups: string }>(
    `WITH src AS (
       SELECT DISTINCT to_date(pay_date,'MM/DD/YYYY') AS d, pay_group
       FROM source.payroll_history
       WHERE pay_date IS NOT NULL
         AND to_date(pay_date,'MM/DD/YYYY') >= DATE '2026-01-01'
     ),
     built AS (
       SELECT DISTINCT to_date(pay_date,'MM/DD/YYYY') AS d FROM accounting.payroll_journal_headers
     )
     SELECT to_char(src.d,'YYYY-MM-DD') AS d, string_agg(DISTINCT src.pay_group, ',') AS groups
     FROM src LEFT JOIN built ON built.d = src.d
     WHERE built.d IS NULL
     GROUP BY 1 ORDER BY 1`,
  );
  console.log(`\n=== SOURCE pay dates >= 2026-01-01 with NO draft yet: ${missing.rowCount} ===`);
  for (const r of missing.rows) console.log(`  ${r.d}  [${r.groups}]`);

  await pool.end();
}

void main();
