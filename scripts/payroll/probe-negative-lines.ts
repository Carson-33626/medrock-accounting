/**
 * READ-ONLY: payroll draft lines with NEGATIVE amounts (Barbara 2026-08-19: FL 04/24
 * shows a -49.55 Debit on Workmen's Comp that she can't flip). A negative debit
 * should be a positive credit — QBO rejects negative JE line amounts.
 *   npx tsx scripts/payroll/probe-negative-lines.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows } = await pool.query<{
      header_id: string; entity: string; pay_date: string; status: string; kind: string;
      posting_type: string; amount: string; account_name: string; memo: string | null; origin: string;
    }>(
      `SELECT h.id::text AS header_id, h.entity, h.pay_date, h.status, h.kind,
              l.posting_type, l.amount::text, l.account_name, l.memo, l.origin
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
       WHERE l.amount < 0
       ORDER BY h.pay_date, h.entity, l.account_name`,
    );
    console.log(`negative-amount lines: ${rows.length}`);
    for (const r of rows) {
      console.log(
        `  #${r.header_id} ${r.entity} ${r.pay_date} [${r.status}/${r.kind}] ${r.posting_type} ${r.amount}  ${r.account_name}  ${r.memo ?? ''} (${r.origin})`,
      );
    }
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
