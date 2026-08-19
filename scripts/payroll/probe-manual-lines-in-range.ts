/**
 * READ-ONLY: every non-posted header in a pay-date range that carries hand-added or
 * hand-edited lines. regen-drafts.ts DELETEs and rebuilds the lines of each header it
 * touches, so anything listed here is work an accountant would lose.
 *   npx tsx scripts/payroll/probe-manual-lines-in-range.ts 2026-05-01 2026-08-31
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

interface Row { id: string; entity: string; pay_date: string; pay_group: string | null; status: string; kind: string; n_manual: string; origins: string }

async function main(): Promise<void> {
  const [start, end] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) {
    console.error('usage: tsx scripts/payroll/probe-manual-lines-in-range.ts <start YYYY-MM-DD> <end YYYY-MM-DD>');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<Row>(
      `SELECT h.id::text, h.entity, h.pay_date, h.pay_group, h.status, h.kind,
              COUNT(*) FILTER (WHERE l.origin <> 'generated')::text AS n_manual,
              string_agg(DISTINCT l.origin, ',') AS origins
         FROM accounting.payroll_journal_headers h
         JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
        WHERE h.status <> 'posted'
          AND to_date(h.pay_date, 'MM/DD/YYYY') BETWEEN $1::date AND $2::date
        GROUP BY h.id, h.entity, h.pay_date, h.pay_group, h.status, h.kind
       HAVING COUNT(*) FILTER (WHERE l.origin <> 'generated') > 0
        ORDER BY to_date(h.pay_date, 'MM/DD/YYYY'), h.id`,
      [start, end],
    );
    console.log(`headers with non-generated lines in ${start}..${end}: ${rows.length}`);
    for (const r of rows) {
      console.log(`  #${r.id} ${r.entity} ${r.pay_date} grp=${r.pay_group ?? '-'} status=${r.status} kind=${r.kind} manual=${r.n_manual} origins=${r.origins}`);
    }
    if (rows.length === 0) console.log('  (nothing a regen would destroy)');
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
