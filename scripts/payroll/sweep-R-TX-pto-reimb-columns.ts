/** READ-ONLY: for TX only, list every distinct ADP payroll_history column matching PTO or
 *  Reimbursement (case-insensitive), with totals through 2026-07-31 — checking whether ADP's
 *  mirror carries an actual accrued-PTO-BALANCE column (distinct from "PTO - EARNING," which is
 *  usage/hours-taken, already mapped to wage expense, not a balance-sheet liability) and whether
 *  Payroll Reimbursement Liabilities (2116) composes cleanly from the Reimbursement/Car
 *  Reimbursement columns already mapped in account-map-seed-data.ts.
 *    npx tsx scripts/payroll/sweep-R-TX-pto-reimb-columns.ts */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';
import { selectSource } from '../../src/lib/payroll/source-select';
import { entityForPayGroup } from '../../src/lib/payroll/entity';

interface ColStat { first: string; last: string; total: number; n: number }

async function main(): Promise<void> {
  const range = await getRdsPool().query<{ lo: string; hi: string }>(
    `SELECT MIN(to_date(pay_date, 'MM/DD/YYYY'))::text AS lo, MAX(to_date(pay_date, 'MM/DD/YYYY'))::text AS hi
       FROM source.payroll_history WHERE to_date(pay_date,'MM/DD/YYYY') <= '2026-07-31'`,
  );
  const rows = await selectSource().fetchRange(range.rows[0].lo, '2026-07-31');
  console.log(`decrypted ${rows.length} rows through 2026-07-31`);

  const ptoStats = new Map<string, ColStat>();
  const reimbStats = new Map<string, ColStat>();
  let txRows = 0;
  for (const row of rows) {
    const entity = entityForPayGroup(row.pay_group);
    if (entity !== 'MedRock TX') continue;
    txRows++;
    for (const [col, val] of Object.entries(row.sensitive)) {
      if (typeof val !== 'number' || val === 0) continue;
      const iso = `${row.pay_date.slice(6, 10)}-${row.pay_date.slice(0, 2)}-${row.pay_date.slice(3, 5)}`;
      const target = /pto/i.test(col) ? ptoStats : /reimb/i.test(col) ? reimbStats : null;
      if (!target) continue;
      const s = target.get(col) ?? { first: '9999', last: '0000', total: 0, n: 0 };
      if (iso < s.first) s.first = iso;
      if (iso > s.last) s.last = iso;
      s.total += val; s.n++;
      target.set(col, s);
    }
  }
  console.log(`TX rows: ${txRows}`);
  console.log('\n--- PTO-matching columns (TX only) ---');
  for (const [col, s] of [...ptoStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  "${col}"  total=${s.total.toFixed(2)}  n=${s.n}  ${s.first}..${s.last}`);
  }
  console.log('\n--- Reimbursement-matching columns (TX only) ---');
  for (const [col, s] of [...reimbStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  "${col}"  total=${s.total.toFixed(2)}  n=${s.n}  ${s.first}..${s.last}`);
  }
  console.log('\nread-only.');
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
