/** READ-ONLY: which Payroll Withholdings lines carry an Allocate flag? Untracked scratch. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ entity: string; pay_date: string; kind: string; status: string; posting_type: string; amount: string; account_name: string; department_name: string | null; class_name: string | null; memo: string | null }>(
    `SELECT h.entity, h.pay_date, h.kind, h.status, l.posting_type, l.amount::text AS amount,
            l.account_name, l.department_name, l.class_name, l.memo
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE l.account_name ILIKE '%Withholding%'
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
      ORDER BY h.pay_date`,
  );
  console.log(`tagged withholdings lines: ${r.rows.length}`);
  for (const x of r.rows) {
    console.log(`  ${x.entity} ${x.pay_date} ${x.kind} ${x.status} | ${x.posting_type} ${Number(x.amount).toFixed(2)} | dept=${x.department_name} class=${x.class_name} | ${x.memo}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
