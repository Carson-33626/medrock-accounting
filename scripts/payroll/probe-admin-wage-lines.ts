/** READ-ONLY: do recent pay-date JEs contain accounting/admin wage lines, and how are they tagged? Untracked scratch. */
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

  const rows = await pool.query<{ entity: string; pay_date: string; status: string; account_name: string; memo: string | null; class_name: string | null; department_name: string | null; total: string }>(
    `SELECT h.entity, h.pay_date, h.status, l.account_name, l.memo, l.class_name, l.department_name, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE (l.account_name ILIKE '%Administrative%' OR l.memo ILIKE '%account%' OR l.memo ILIKE '%admin%')
        AND h.kind = 'pay_date'
        AND h.pay_date ~ '^0[5678]/[0-9]+/2026$'
        AND l.posting_type = 'Debit'
      GROUP BY h.entity, h.pay_date, h.status, l.account_name, l.memo, l.class_name, l.department_name
      ORDER BY h.pay_date DESC, h.entity LIMIT 40`,
  );
  console.log(`pay-date JE debit lines touching Administrative/Accounting, May-Aug 2026: ${rows.rows.length}`);
  for (const x of rows.rows) {
    console.log(`  ${x.entity} ${x.pay_date} [${x.status}] ${x.account_name} | memo=${x.memo} | class=${x.class_name} dept=${x.department_name} | $${Number(x.total).toFixed(2)}`);
  }

  const kinds = await pool.query<{ kind: string; status: string; n: string; latest: string }>(
    `SELECT kind, status, COUNT(*)::text AS n, MAX(pay_date) AS latest
       FROM accounting.payroll_journal_headers
      GROUP BY kind, status ORDER BY kind, status`,
  );
  console.log(`\nheader counts by kind/status:`);
  for (const x of kinds.rows) console.log(`  ${x.kind} / ${x.status}: ${x.n} (latest pay_date ${x.latest})`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
