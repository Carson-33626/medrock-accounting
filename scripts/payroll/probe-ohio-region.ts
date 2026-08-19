/**
 * READ-ONLY: find every place 'Ohio Region' still lives (employee map + draft lines),
 * so the TN naming trap ('Ohio Region' in our data vs 'OH Region' in TN's QB book) can
 * be repointed everywhere rather than per-header.
 *   npx tsx scripts/payroll/probe-ohio-region.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

interface MapRow { id: string; entity: string; position_id: string; department_name: string; class_name: string | null; active: boolean }
interface LineRow { header_id: string; entity: string; pay_date: string; status: string; n: string }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: mapRows } = await pool.query<MapRow>(
      `SELECT id::text, entity, position_id, department_name, class_name, active
         FROM accounting.payroll_employee_map
        WHERE department_name ILIKE '%ohio%'
        ORDER BY entity, position_id`,
    );
    console.log(`\nEMPLOYEE MAP rows with an 'Ohio%' department: ${mapRows.length}`);
    for (const r of mapRows) {
      console.log(`  id=${r.id} ${r.entity} pos=${r.position_id} dept='${r.department_name}' class=${r.class_name ?? '-'} active=${r.active}`);
    }

    const { rows: lineRows } = await pool.query<LineRow>(
      `SELECT l.header_id::text, h.entity, h.pay_date::text, h.status, COUNT(*)::text AS n
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name ILIKE '%ohio%'
        GROUP BY l.header_id, h.entity, h.pay_date, h.status
        ORDER BY h.pay_date, l.header_id`,
    );
    console.log(`\nDRAFT HEADERS carrying 'Ohio%' lines: ${lineRows.length}`);
    for (const r of lineRows) {
      console.log(`  #${r.header_id} ${r.entity} ${r.pay_date} status=${r.status} lines=${r.n}`);
    }
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
