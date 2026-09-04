/** READ-ONLY: ANY credit line still carrying an Allocate flag? Should be zero. Untracked scratch. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const r = await getRdsPool().query<{ kind: string; account_name: string; n: string; total: string }>(
    `SELECT h.kind, l.account_name, COUNT(*)::text AS n, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE l.posting_type = 'Credit'
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
        AND h.kind IN ('pay_date', 'accrual', 'reversal')
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  console.log(`tagged CREDIT lines in payroll-kind drafts: ${r.rows.length === 0 ? 'NONE (correct)' : ''}`);
  for (const x of r.rows) console.log(`  ${x.kind} ${x.account_name}: ${x.n} lines $${Number(x.total).toFixed(2)}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
