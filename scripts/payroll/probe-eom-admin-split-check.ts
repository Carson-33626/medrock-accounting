/** READ-ONLY: why isn't the accounting/admin split showing on the EOM tab? Untracked scratch.
 *  Checks: (1) payroll_allocation_rule rows, (2) employee-map Allocate flags,
 *  (3) journal lines carrying Allocate - %, and whether their headers posted,
 *  (4) latest eom_runs pool contents. */
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

  const rules = await pool.query<{ cost_center: string; target_entity: string; percent: string; effective_from: string; active: boolean }>(
    `SELECT cost_center, target_entity, percent::text, effective_from::text, active
       FROM accounting.payroll_allocation_rule ORDER BY cost_center, target_entity`,
  );
  console.log(`\n[1] payroll_allocation_rule rows: ${rules.rows.length}`);
  for (const r of rules.rows) console.log(`    ${r.cost_center} -> ${r.target_entity} ${r.percent}% from ${r.effective_from} active=${r.active}`);

  const emp = await pool.query<{ entity: string; position_id: string; department_name: string | null; class_name: string | null; active: boolean }>(
    `SELECT entity, position_id, department_name, class_name, active
       FROM accounting.payroll_employee_map
      WHERE class_name LIKE 'Allocate%' ORDER BY entity, position_id`,
  );
  console.log(`\n[2] employee-map rows with Allocate class: ${emp.rows.length}`);
  for (const r of emp.rows) console.log(`    ${r.entity} ${r.position_id} dept=${r.department_name} class=${r.class_name} active=${r.active}`);

  const lines = await pool.query<{ entity: string; pay_date: string; status: string; kind: string; n: string; total: string }>(
    `SELECT h.entity, h.pay_date, h.status, h.kind, COUNT(*)::text AS n, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE l.class_name = 'Allocate - %'
      GROUP BY h.entity, h.pay_date, h.status, h.kind
      ORDER BY h.pay_date DESC, h.entity LIMIT 40`,
  );
  console.log(`\n[3] draft/posted JE headers containing 'Allocate - %' lines (latest 40 groups):`);
  for (const r of lines.rows) console.log(`    ${r.entity} ${r.pay_date} kind=${r.kind} status=${r.status} lines=${r.n} sum=$${Number(r.total).toFixed(2)}`);

  const runs = await pool.query<{ month: string; created_at: string; pool: unknown }>(
    `SELECT month, generated_at::text AS created_at, pool FROM accounting.payroll_eom_runs ORDER BY generated_at DESC LIMIT 3`,
  );
  console.log(`\n[4] latest eom_runs: ${runs.rows.length}`);
  for (const r of runs.rows) {
    const p = r.pool as Array<{ entity: string; accountName: string; amount: number; txnType: string; rule: string }>;
    console.log(`  month=${r.month} created=${r.created_at} poolLines=${Array.isArray(p) ? p.length : '?'}`);
    if (Array.isArray(p)) {
      const byAcct = new Map<string, { n: number; total: number }>();
      for (const l of p) {
        const k = `${l.accountName} [${l.rule}]`;
        const cur = byAcct.get(k) ?? { n: 0, total: 0 };
        cur.n++; cur.total += l.amount;
        byAcct.set(k, cur);
      }
      for (const [k, v] of [...byAcct.entries()].sort((a, b) => b[1].total - a[1].total)) {
        console.log(`      ${k}: ${v.n} lines, $${v.total.toFixed(2)}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
