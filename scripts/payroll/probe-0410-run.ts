/**
 * READ-ONLY: state of the 04/10/2026 payroll run — headers, pieces, statuses, totals,
 * and whether the lines carry Location (department) dimensions. Context: Barbara asked
 * for a one-off JE for "the location split from the payroll we did for the 4-10"
 * (2026-08-19), right after her QBO CSV import of PR 2026.04.10A failed.
 *   npx tsx scripts/payroll/probe-0410-run.ts
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

interface HeaderRow {
  id: string; entity: string; kind: string; pay_date: string; pay_group: string;
  period_segment: string | null; period_start: string | null; period_end: string | null;
  txn_date: string | null; status: string; qb_doc_number: string | null; qb_entry_id: string | null;
  total_debits: string; total_credits: string; variance: string; row_count: string;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<HeaderRow>(
      `SELECT id::text, entity, kind, pay_date, pay_group, period_segment, period_start, period_end,
              txn_date::text AS txn_date, status, qb_doc_number, qb_entry_id,
              total_debits::text, total_credits::text, variance::text, row_count::text
       FROM accounting.payroll_journal_headers
       WHERE pay_date = '04/10/2026'
       ORDER BY entity, pay_group, period_segment`,
    );
    console.log(`headers for pay_date 04/10/2026: ${rows.length}`);
    for (const h of rows) {
      console.log(
        `  #${h.id} ${h.entity} ${h.pay_group} kind=${h.kind} seg=${h.period_segment ?? '-'} ` +
        `txn=${h.txn_date} status=${h.status} doc=${h.qb_doc_number ?? '-'} qbId=${h.qb_entry_id ?? '-'} ` +
        `Dr=${h.total_debits} Cr=${h.total_credits} var=${h.variance} rows=${h.row_count} ` +
        `period=${h.period_start}..${h.period_end}`,
      );
    }
    // Do the lines carry Location dims? Sample distinct departments per header.
    const { rows: depts } = await pool.query<{ header_id: string; department_name: string | null; n: string }>(
      `SELECT l.header_id::text, l.department_name, COUNT(*)::text AS n
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE h.pay_date = '04/10/2026'
       GROUP BY l.header_id, l.department_name
       ORDER BY l.header_id, l.department_name`,
    );
    console.log('\nlines by (header, Location/department):');
    for (const d of depts) console.log(`  header ${d.header_id}: ${d.department_name ?? '(none)'} × ${d.n}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
