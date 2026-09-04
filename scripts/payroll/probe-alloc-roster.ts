/** READ-ONLY: roster + safety checks before tagging admin/accounting/HR for allocation. Untracked scratch.
 *  [1] distinct home_department values in 2026 source rows
 *  [2] position_ids for ADMIN/ACCOUN/HR-ish departments, with entity (pay_group) + name
 *  [3] existing employee-map rows for those positions
 *  [4] manual/inter_entity lines on unposted pay_date headers (regen would delete them)
 *  [5] approved (not posted) headers (regen resets them to needs_review) */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const pool = getRdsPool();

  const depts = await pool.query<{ home_department: string; n: string }>(
    `SELECT home_department, COUNT(DISTINCT position_id)::text AS n
       FROM source.payroll_history
      WHERE pay_date LIKE '%/2026'
      GROUP BY home_department ORDER BY home_department`,
  );
  console.log('[1] distinct home_department (2026):');
  for (const r of depts.rows) console.log(`    ${JSON.stringify(r.home_department)} — ${r.n} people`);

  const roster = await pool.query<{ position_id: string; name: string; home_department: string; pay_group: string; status: string; latest: string }>(
    `SELECT DISTINCT ON (position_id, pay_group) position_id, name, home_department, pay_group, status,
            to_date(pay_date, 'MM/DD/YYYY')::text AS latest
       FROM source.payroll_history
      WHERE pay_date LIKE '%/2026'
        AND (UPPER(home_department) LIKE 'ADMIN%' OR UPPER(home_department) LIKE 'ACCOUN%' OR UPPER(home_department) LIKE 'HR%' OR UPPER(home_department) LIKE '%HUMAN%')
      ORDER BY position_id, pay_group, to_date(pay_date, 'MM/DD/YYYY') DESC`,
  );
  console.log(`\n[2] ADMIN/ACCOUN/HR roster (2026): ${roster.rows.length}`);
  for (const r of roster.rows) console.log(`    ${r.position_id} ${r.name} | dept=${r.home_department} | pay_group=${r.pay_group} | status=${r.status} | last pay ${r.latest}`);

  const ids = roster.rows.map((r) => r.position_id);
  const emp = await pool.query<{ entity: string; position_id: string; department_name: string | null; class_name: string | null; active: boolean; reviewed: boolean }>(
    `SELECT entity, position_id, department_name, class_name, active, reviewed
       FROM accounting.payroll_employee_map WHERE position_id = ANY($1)`,
    [ids],
  );
  console.log(`\n[3] existing employee-map rows for those positions: ${emp.rows.length}`);
  for (const r of emp.rows) console.log(`    ${r.entity} ${r.position_id} dept=${r.department_name} class=${r.class_name} active=${r.active} reviewed=${r.reviewed}`);

  const manual = await pool.query<{ entity: string; pay_date: string; origin: string; n: string }>(
    `SELECT h.entity, h.pay_date, l.origin, COUNT(*)::text AS n
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.kind = 'pay_date' AND h.status <> 'posted' AND l.origin <> 'generated'
      GROUP BY h.entity, h.pay_date, l.origin ORDER BY h.pay_date`,
  );
  console.log(`\n[4] non-generated lines on unposted pay_date headers: ${manual.rows.length ? '' : 'none'}`);
  for (const r of manual.rows) console.log(`    ${r.entity} ${r.pay_date} origin=${r.origin} lines=${r.n}`);

  const approved = await pool.query<{ id: number; entity: string; pay_date: string; pay_group: string }>(
    `SELECT id, entity, pay_date, pay_group FROM accounting.payroll_journal_headers
      WHERE status = 'approved' ORDER BY pay_date`,
  );
  console.log(`\n[5] approved (unposted) headers: ${approved.rows.length ? '' : 'none'}`);
  for (const r of approved.rows) console.log(`    #${r.id} ${r.entity} ${r.pay_date} ${r.pay_group}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
