/**
 * READ-ONLY: for the TN headers that carried the 'Ohio Region' name, report what a
 * regen would destroy — manual/edited lines and approval state — before anyone runs
 * regen-drafts.ts over those pay dates.
 *   npx tsx scripts/payroll/probe-regen-risk.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const HEADERS = [1159, 1160, 52, 1169, 1170, 21, 1216, 1217, 204, 3, 214, 760, 2095, 2418, 2419];

interface Row {
  id: string; entity: string; pay_date: string; pay_group: string | null; status: string;
  n_lines: string; n_manual: string;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<Row>(
      `SELECT h.id::text, h.entity, h.pay_date::text, h.pay_group, h.status,
              COUNT(l.*)::text AS n_lines,
              COUNT(*) FILTER (WHERE l.origin <> 'generated')::text AS n_manual
         FROM accounting.payroll_journal_headers h
         LEFT JOIN accounting.payroll_journal_lines l ON l.header_id = h.id
        WHERE h.id = ANY($1::bigint[])
        GROUP BY h.id, h.entity, h.pay_date, h.pay_group, h.status
        ORDER BY h.pay_date, h.id`,
      [HEADERS],
    );
    for (const r of rows) {
      const flag = Number(r.n_manual) > 0 ? '  <-- MANUAL LINES' : '';
      console.log(`  #${r.id} ${r.entity} ${r.pay_date} grp=${r.pay_group ?? '-'} status=${r.status} lines=${r.n_lines} manual=${r.n_manual}${flag}`);
    }
    const dates = [...new Set(rows.map((r) => r.pay_date))].sort();
    console.log(`\ndistinct pay dates: ${dates.join(', ')}`);
    console.log(`approved headers: ${rows.filter((r) => r.status === 'approved').map((r) => `#${r.id}`).join(', ') || 'none'}`);
    console.log(`headers with manual lines: ${rows.filter((r) => Number(r.n_manual) > 0).map((r) => `#${r.id}`).join(', ') || 'none'}`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
