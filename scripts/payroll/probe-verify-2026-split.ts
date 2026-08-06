/** READ-ONLY: verify the cost-center split landed on regenerated 2026 drafts. Untracked scratch. */
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

  const split = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026' AND l.memo LIKE '% - %'`,
  );
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026'`,
  );
  console.log(`2026 lines total=${total.rows[0].n}, with " - <Dept>" memo=${split.rows[0].n}`);

  const sample = await pool.query<{ entity: string; pay_date: string; account_name: string; memo: string; posting_type: string; amount: string }>(
    `SELECT h.entity, h.pay_date, l.account_name, l.memo, l.posting_type, l.amount::text AS amount
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.pay_date LIKE '%/2026' AND l.account_name = 'Payroll Withholdings' AND l.credit_bucket = 'Net Pay'
      ORDER BY h.pay_date DESC, l.memo LIMIT 12`,
  );
  console.log('\nSample regenerated Net Pay credit lines (should be split by department):');
  for (const r of sample.rows) {
    console.log(`  ${r.entity} ${r.pay_date} | ${r.posting_type} ${Number(r.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} | memo="${r.memo}"`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
