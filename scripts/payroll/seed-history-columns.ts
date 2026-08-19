/**
 * History-proof the account map: rules for 15 columns that carried money in 2025 payroll
 * history but had no rule (found by probe-history-unmapped-columns.ts). Each is an exact
 * copy of an existing rule family's shape:
 *
 *  - EE withholdings -> cc=* Credit Payroll Withholdings (bucket per family):
 *      NJ income tax, PA SUI-EE + PA local taxes (WILL recur — Lymberis is a PA employee),
 *      PR tax aggregate, post-tax dental/vision (Health), 401k EE variants (Retirement),
 *      pay-correction deduction (Employee Advances/Other, like ADV DEDUCTION / COMPANY LOAN).
 *  - ER families -> 9 cost-center Debits (Employer Taxes | 401K Match; COGS for LAB/PHARM/RD)
 *      + cc=* Credit Payroll Withholdings: PA SUI-ER, 401k catch-up ER, bare 401k match ER.
 *  - Reimbursement -> cc=* Debit Payroll Reimbursement Liabilities (like CAR REIMBURSEMENT).
 *
 * Deliberately NOT seeded (accounting judgment, ask Barbara): SEVERANCE US - EARNING,
 * COMMISSION - EARNING. 1099 CONTRACTOR - EARNING needs no rule (pay group excluded by design).
 *
 *   npx tsx scripts/payroll/seed-history-columns.ts --apply
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import type { AccountMapRule, Entity, PostingType } from '../../src/lib/payroll/types';
import { upsertAccountRule } from '../../src/lib/payroll/store';

const apply = process.argv.includes('--apply');
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX', 'FOCAS'];

type CreditBucket = AccountMapRule['creditBucket'];

interface Shape { adpColumn: string; costCenter: string; accountName: string; postingType: PostingType; isCogs: boolean; creditBucket: CreditBucket; memo: string | null }

/** cc=* Credit -> Payroll Withholdings, per-family bucket. */
const eeCredit = (col: string, bucket: CreditBucket, accountName = 'Payroll Withholdings'): Shape[] => [
  { adpColumn: col, costCenter: '*', accountName, postingType: 'Credit', isCogs: false, creditBucket: bucket, memo: null },
];

/** The 9-cc ER debit family + '*' credit, exactly as AZ/CO SUI-ER and RS 401K BASE MATCH ER. */
const erFamily = (col: string, expenseAccount: string, cogsAccount: string, memoBase: string): Shape[] => {
  const cc: Array<{ c: string; dept: string; cogs: boolean }> = [
    { c: 'ACCOUN', dept: 'Accounting', cogs: false }, { c: 'ADMIN', dept: 'Admin', cogs: false },
    { c: 'CS', dept: 'CSR', cogs: false }, { c: 'DATA', dept: 'DE', cogs: false },
    { c: 'LAB', dept: 'Lab', cogs: true }, { c: 'MARKET', dept: 'Marketing', cogs: false },
    { c: 'PHARM', dept: 'Pharmacists', cogs: true }, { c: 'RD', dept: 'R & D', cogs: true },
    { c: 'SHIP', dept: 'Shipping', cogs: false },
  ];
  return [
    ...cc.map((x): Shape => ({
      adpColumn: col, costCenter: x.c, accountName: x.cogs ? cogsAccount : expenseAccount,
      postingType: 'Debit', isCogs: x.cogs, creditBucket: null, memo: `${memoBase} - ${x.dept}`,
    })),
    { adpColumn: col, costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: memoBase === '401K' ? 'Retirement' : 'Taxes', memo: null },
  ];
};

const SHAPES: Shape[] = [
  // EE state/local taxes -> Taxes bucket
  ...eeCredit('NJ STATE - EE INCOME TAX', 'Taxes'),
  ...eeCredit('PA STATE - UNEMPLOYMENT INSURANCE EE', 'Taxes'),
  ...eeCredit('TOWN : LOCAL - EE INCOME TAX', 'Taxes'),
  ...eeCredit('TOWN : LOCAL - EE LOCAL SERVICES TAX', 'Taxes'),
  ...eeCredit('PRTAXES - EE', 'Taxes'),
  // EE benefit deductions -> Health bucket (same target as the PRE-TAX analogues)
  ...eeCredit('DENTAL - EE POST-TAX', 'Health'),
  ...eeCredit('VISION - EE POST-TAX', 'Health'),
  // EE 401k -> Retirement bucket (bare pre-plan-number naming + catch-up)
  ...eeCredit('401K - TRADITIONAL EE', 'Retirement'),
  ...eeCredit('401K - ROTH EE', 'Retirement'),
  ...eeCredit('RS 401K 088086 - CATCHUP TRADITIONAL EE', 'Retirement'),
  // Pay-correction clawback -> Employee Advances, like ADV DEDUCTION / COMPANY LOAN
  ...eeCredit('PAYCORRECTIONDED - EE - PRINCIPAL POST-TAX', 'Other', 'Employee Advances'),
  // ER families
  ...erFamily('PA STATE - UNEMPLOYMENT INSURANCE ER', 'Payroll Expense -:Employer Taxes', 'COGS - Payroll Expense:COGS - Employer Payroll Taxes', 'ER Taxes'),
  ...erFamily('RS 401K 088086 - CATCHUP ER', 'Payroll Expense -:401K Employer Match', 'COGS - Payroll Expense:COGS - 401K Employer Match', '401K'),
  ...erFamily('401K - BASE MATCH ER', 'Payroll Expense -:401K Employer Match', 'COGS - Payroll Expense:COGS - 401K Employer Match', '401K'),
  // Reimbursement correction -> pooled Debit like CAR REIMBURSEMENT's '*' rule
  { adpColumn: 'PAYCORRECTION - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT', costCenter: '*', accountName: 'Payroll Reimbursement Liabilities', postingType: 'Debit', isCogs: false, creditBucket: null, memo: 'Pay Correction Reimbursement' },
];

async function main(): Promise<void> {
  const total = SHAPES.length * ENTITIES.length;
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW'} — ${SHAPES.length} shapes × ${ENTITIES.length} entities = ${total} rules`);
  let n = 0;
  for (const entity of ENTITIES) {
    for (const s of SHAPES) {
      if (apply) {
        await upsertAccountRule({ entity, adpColumn: s.adpColumn, costCenter: s.costCenter, accountName: s.accountName, postingType: s.postingType, isCogs: s.isCogs, creditBucket: s.creditBucket, active: true, memo: s.memo });
        n++;
      }
    }
    console.log(`  ${entity}: ${apply ? 'upserted' : 'would upsert'} ${SHAPES.length} rules`);
  }
  if (apply) console.log(`done: ${n} rules upserted`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
