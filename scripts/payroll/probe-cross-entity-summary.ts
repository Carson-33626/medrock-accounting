/**
 * READ-ONLY companion to probe-cross-entity-regions.ts: collapse the cross-entity region
 * drift to one row per entity+region+pay_date, and flag whether each pay date is inside a
 * CLOSED period (pre-04/10/2026, per period-locks.ts). A closed pay date can never post,
 * so drift there blocks nothing and must not drive a QuickBooks change.
 *   npx tsx scripts/payroll/probe-cross-entity-summary.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { isPayrollPeriodComplete } from '../../src/lib/payroll/period-locks';

const NAMES = ['MD/DC/VA Region', 'Puerto Rico Region'];

interface Row { entity: string; department_name: string; pay_date: string; status: string; headers: string; n: string }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<Row>(
      `SELECT h.entity, l.department_name, h.pay_date, h.status,
              string_agg(DISTINCT l.header_id::text, ',') AS headers, COUNT(*)::text AS n
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = ANY($1::text[]) AND h.status <> 'posted'
        GROUP BY h.entity, l.department_name, h.pay_date, h.status
        ORDER BY h.entity, l.department_name, to_date(h.pay_date,'MM/DD/YYYY')`,
      [NAMES],
    );

    let openLines = 0;
    for (const r of rows) {
      const locked = isPayrollPeriodComplete(r.pay_date);
      if (!locked) openLines += Number(r.n);
      console.log(`  ${r.entity.padEnd(11)} ${r.department_name.padEnd(18)} ${r.pay_date} ${locked ? 'CLOSED (never postable)' : '>>> OPEN <<<'} lines=${r.n} headers=${r.headers}`);
    }
    console.log(`\nlines on OPEN (postable) pay dates: ${openLines}`);
    if (openLines === 0) {
      console.log('Every affected pay date is inside a closed period — this drift blocks no post.');
    }
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
