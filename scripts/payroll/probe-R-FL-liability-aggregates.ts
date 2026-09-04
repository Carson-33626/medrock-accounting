/** READ-ONLY: FL cumulative ADP aggregates through 07/31/2026 for four liability accounts
 * R-FL could not previously compose: 2020 Garnishment, 2117 PR Payroll, 2135 PTO, 2116 Reimbursement.
 * Full population, all source.payroll_history rows, not a sample.
 *    npx tsx scripts/payroll/probe-R-FL-liability-aggregates.ts */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow } from '../../src/lib/payroll/types';

interface RawRow { position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const toISO = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '9999-99-99';
};

const GARNISH_COLS = ['CREDITOR GARNISHMENT - TOTAL', 'GARNISH'];
const PR_COLS = [
  'PR STATE - EE INCOME TAX', 'PR STATE - DISABILITY INSURANCE  EE', 'PR STATE - MEDICARE  EE',
  'PR STATE - SOCIAL SECURITY  EE',
];
const PTO_COLS = ['PTO - EARNING', 'PTO CASHOUT - EARNING'];
const REIMB_COLS = ['CAR REIMBURSEMENT - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT', 'PAYCORRECTION - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT', 'REIMBURSEMENT - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT'];

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const pool = getRdsPool();
  const { rows } = await pool.query<RawRow>(
    `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history`,
  );
  console.log(`Total rows pulled: ${rows.length}`);

  const buckets = {
    garnish: { cum: 0, july: 0, hits: 0 },
    pr: { cum: 0, july: 0, hits: 0 },
    pto: { cum: 0, july: 0, hits: 0 },
    reimb: { cum: 0, july: 0, hits: 0 },
  };

  for (const r of rows) {
    if (entityForPayGroup(r.pay_group ?? '') !== 'MedRock FL') continue;
    const iso = toISO(r.pay_date ?? '');
    if (iso > '2026-07-31') continue; // cumulative through close date
    const isJuly = iso >= '2026-07-01' && iso <= '2026-07-31';
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const [col, val] of Object.entries(s)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (GARNISH_COLS.some((c) => col.includes(c))) {
        buckets.garnish.cum += val; buckets.garnish.hits++;
        if (isJuly) buckets.garnish.july += val;
      }
      if (PR_COLS.some((c) => col === c)) {
        buckets.pr.cum += val; buckets.pr.hits++;
        if (isJuly) buckets.pr.july += val;
      }
      if (PTO_COLS.some((c) => col === c)) {
        buckets.pto.cum += val; buckets.pto.hits++;
        if (isJuly) buckets.pto.july += val;
      }
      if (REIMB_COLS.some((c) => col === c)) {
        buckets.reimb.cum += val; buckets.reimb.hits++;
        if (isJuly) buckets.reimb.july += val;
      }
    }
  }

  console.log('\n=== FL cumulative through 07/31/2026 (all pay dates), and July-2026-only ===');
  console.log(`Garnishment (CREDITOR GARNISHMENT / GARNISH*): cum=${money(buckets.garnish.cum)} july=${money(buckets.garnish.july)} hits=${buckets.garnish.hits}`);
  console.log(`PR STATE EE taxes (income/disability/medicare/SS): cum=${money(buckets.pr.cum)} july=${money(buckets.pr.july)} hits=${buckets.pr.hits}`);
  console.log(`PTO earning + cashout (usage side only, not accrual): cum=${money(buckets.pto.cum)} july=${money(buckets.pto.july)} hits=${buckets.pto.hits}`);
  console.log(`Reimbursement (car/paycorrection/general, non-taxable): cum=${money(buckets.reimb.cum)} july=${money(buckets.reimb.july)} hits=${buckets.reimb.hits}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
