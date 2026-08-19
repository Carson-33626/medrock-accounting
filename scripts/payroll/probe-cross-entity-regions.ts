/**
 * READ-ONLY: why do FL drafts reference 'MD/DC/VA Region' (a TN region) and TN drafts
 * reference 'Puerto Rico Region' (an FL region)? Prints the employee-map rules behind
 * those names and the draft headers carrying them, so we can tell a stale draft from a
 * genuinely mis-entitied mapping.
 *   npx tsx scripts/payroll/probe-cross-entity-regions.ts
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const NAMES = ['MD/DC/VA Region', 'Puerto Rico Region'];

interface MapRow { id: string; entity: string; position_id: string; department_name: string; class_name: string | null; active: boolean }
interface LineRow { header_id: string; entity: string; pay_date: string; status: string; department_name: string; account_name: string; memo: string | null; amount: string; posting_type: string; origin: string }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: maps } = await pool.query<MapRow>(
      `SELECT id::text, entity, position_id, department_name, class_name, active
         FROM accounting.payroll_employee_map
        WHERE department_name = ANY($1::text[])
        ORDER BY department_name, entity, position_id`,
      [NAMES],
    );
    console.log(`EMPLOYEE MAP rules naming these regions: ${maps.length}`);
    for (const r of maps) {
      console.log(`  ${r.department_name.padEnd(18)} entity=${r.entity.padEnd(11)} pos=${r.position_id} class=${r.class_name ?? '-'} active=${r.active}`);
    }

    const { rows: lines } = await pool.query<LineRow>(
      `SELECT l.header_id::text, h.entity, h.pay_date, h.status, l.department_name,
              l.account_name, l.memo, l.amount::text, l.posting_type, l.origin
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = ANY($1::text[]) AND h.status <> 'posted'
        ORDER BY l.department_name, h.entity, to_date(h.pay_date,'MM/DD/YYYY'), l.header_id`,
      [NAMES],
    );
    console.log(`\nUNPOSTED draft lines carrying them: ${lines.length}`);
    for (const r of lines) {
      console.log(`  #${r.header_id} ${r.entity} ${r.pay_date} [${r.status}] ${r.department_name} | ${r.posting_type} ${r.amount} ${r.account_name} | memo='${r.memo ?? ''}' origin=${r.origin}`);
    }

    // Was the pairing ever different? Show the newest header per entity/region so we can see
    // whether recent regens still produce the cross-entity pairing (mapping bug) or whether it
    // only appears on old headers (stale drafts, same as the Ohio case).
    const { rows: newest } = await pool.query<{ entity: string; department_name: string; latest: string; header_id: string }>(
      `SELECT DISTINCT ON (h.entity, l.department_name)
              h.entity, l.department_name, h.pay_date AS latest, l.header_id::text
         FROM accounting.payroll_journal_lines l
         JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
        WHERE l.department_name = ANY($1::text[])
        ORDER BY h.entity, l.department_name, to_date(h.pay_date,'MM/DD/YYYY') DESC`,
      [NAMES],
    );
    console.log(`\nNEWEST pay date per entity+region (incl. posted):`);
    for (const r of newest) console.log(`  ${r.entity.padEnd(11)} ${r.department_name.padEnd(18)} latest=${r.latest} (#${r.header_id})`);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
