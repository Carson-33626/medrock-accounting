/**
 * READ-ONLY: list approved (not yet posted) headers in a pay-date range, so a regen —
 * which resets every non-posted header to 'needs_review' — is run knowing exactly which
 * approvals it will clear and need re-doing.
 *   npx tsx scripts/payroll/probe-approved-in-range.ts 2026-05-01 2026-08-31
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

interface Row { id: string; entity: string; pay_date: string; pay_group: string | null; kind: string }

async function main(): Promise<void> {
  const [start, end] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) {
    console.error('usage: tsx scripts/payroll/probe-approved-in-range.ts <start YYYY-MM-DD> <end YYYY-MM-DD>');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<Row>(
      `SELECT id::text, entity, pay_date, pay_group, kind
         FROM accounting.payroll_journal_headers
        WHERE status = 'approved'
          AND to_date(pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date
        ORDER BY to_date(pay_date, 'MM/DD/YYYY'), id`,
      [start, end],
    );
    console.log(`approved (unposted) headers in ${start}..${end}: ${rows.length}`);
    for (const r of rows) console.log(`  #${r.id} ${r.entity} ${r.pay_date} grp=${r.pay_group ?? '-'} kind=${r.kind}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
