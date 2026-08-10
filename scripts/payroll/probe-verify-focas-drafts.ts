/**
 * READ-ONLY: FOCAS draft shape + global posting status. Answers "has anything actually been
 * posted to QuickBooks yet?" and "do the 12 FOCAS pay_date headers carry any lines at all?"
 *   npx tsx scripts/payroll/probe-verify-focas-drafts.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const a = await pool.query<{ status: string; n: string; with_qb_id: string }>(
      `SELECT status, count(*)::text AS n, count(qb_entry_id)::text AS with_qb_id
       FROM accounting.payroll_journal_headers GROUP BY 1 ORDER BY 1`,
    );
    console.log('-- all payroll_journal_headers by status --');
    for (const r of a.rows) console.log(`  ${r.status.padEnd(16)} n=${String(r.n).padStart(4)}  with qb_entry_id=${r.with_qb_id}`);

    const b = await pool.query<{ pay_date: string; status: string; lines: string; unmapped: string }>(
      `SELECT h.pay_date, h.status, count(l.id)::text AS lines, h.row_count::text AS unmapped
       FROM accounting.payroll_journal_headers h
       LEFT JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
       WHERE h.entity = 'FOCAS'
       GROUP BY h.id, h.pay_date, h.status, h.row_count ORDER BY h.pay_date`,
    );
    console.log(`\n-- FOCAS headers: ${b.rows.length} --`);
    for (const r of b.rows) console.log(`  ${r.pay_date} status=${r.status.padEnd(14)} JE lines=${r.lines}  source rows=${r.unmapped}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
