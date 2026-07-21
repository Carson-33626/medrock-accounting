import { describe, it, expect } from 'vitest';
import { buildSeedAccountMap } from './account-map-seed-data';
import { POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildJournal } from '../../src/lib/payroll/build-je';
import type { PayrollRow } from '../../src/lib/payroll/types';

/**
 * Regression cover for the company-loan mapping (Barbara, 2026-07-20). Leaving this
 * column unmapped dropped its credit line while NET PAY already reflected the
 * deduction, which is what produced the FL ~$250 / TN $1,391.35 residuals.
 */
describe('COMPANY LOAN - EE - PRINCIPAL POST-TAX', () => {
  const COLUMN = 'COMPANY LOAN - EE - PRINCIPAL POST-TAX';

  it('is mapped for every postable entity', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const matches = buildSeedAccountMap(entity).filter((r) => r.adpColumn === COLUMN);
      expect(matches, `${entity} should map ${COLUMN}`).toHaveLength(1);
    }
  });

  it('credits QBO 1215 Employee Advances, not the withholdings pool', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const rule = buildSeedAccountMap(entity).find((r) => r.adpColumn === COLUMN);
      // Repaying an advance retires an asset — it must not land in the liability pool.
      expect(rule?.accountName).toBe('Employee Advances');
      expect(rule?.postingType).toBe('Credit');
      expect(rule?.costCenter).toBe('*');
      expect(rule?.active).toBe(true);
      expect(rule?.isCogs).toBe(false);
    }
  });
});

/**
 * Pooled '*' debit specials (MEDICAL - ER, CAR ALLOWANCE, REIMBURSEMENT, BONUS) used to emit a
 * single memo-less line per account, so an accountant saw one lumped 'Accrued Payroll Liability'
 * figure with no department (Barbara 2026-07-21, screenshot 2). They now split per cost center
 * with a department memo — same account, one readable line per department — while keeping a '*'
 * memo-less fallback so a blank/unknown-department row still maps (no new unmapped column).
 */
describe('pooled debit specials split by department memo', () => {
  const NINE_COST_CENTERS = 9; // LAB PHARM RD ADMIN ACCOUN CS DATA SHIP MARKET

  const SPECIALS: ReadonlyArray<{ column: string; account: string; memoPrefix: string }> = [
    { column: 'MEDICAL - ER', account: 'Accrued Payroll Liability', memoPrefix: 'ER Medical - ' },
    { column: 'CAR ALLOWANCE - EARNING', account: 'Accrued Payroll Liability', memoPrefix: 'Car Allowance - ' },
    { column: 'REIMBURSEMENT - REIMBURSEMENT NON-TAXABLE NON TAXABLE REIMBURSEMENT', account: 'Payroll Reimbursement Liabilities', memoPrefix: 'Reimbursement - ' },
    { column: 'BONUS - EARNING', account: 'Payroll Expense -:Bonus Wages', memoPrefix: 'Bonus - ' },
  ];

  it('emits one memo-labelled debit per cost center plus a memo-less * fallback, per entity', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      for (const { column, account, memoPrefix } of SPECIALS) {
        const debits = rules.filter((r) => r.adpColumn === column && r.postingType === 'Debit');
        const perDept = debits.filter((r) => r.costCenter !== '*');
        const fallback = debits.filter((r) => r.costCenter === '*');
        expect(perDept, `${entity} ${column}`).toHaveLength(NINE_COST_CENTERS);
        expect(fallback, `${entity} ${column} fallback`).toHaveLength(1);
        for (const r of perDept) {
          expect(r.accountName).toBe(account);
          expect(r.memo ?? '').toContain(memoPrefix);
        }
        // fallback stays memo-less so it uses the creditBucket label, like other pooled lines.
        expect(fallback[0]?.memo ?? null).toBeNull();
        expect(fallback[0]?.accountName).toBe(account);
      }
    }
  });

  it('maps PTHOLIDAY - EARNING as a per-department wage earning (fixes the re-flagging column)', () => {
    // PTHOLIDAY (paid holiday) is a wage earning like HOLIDAY PAY - EARNING — it was missing from
    // the seed, so it kept surfacing as "new column detected". It should map per cost center to the
    // regular wage account with a "<Dept> Wages" memo, exactly like the other earning columns.
    for (const entity of POSTABLE_ENTITIES) {
      const rules = buildSeedAccountMap(entity).filter((r) => r.adpColumn === 'PTHOLIDAY - EARNING');
      const perDept = rules.filter((r) => r.postingType === 'Debit' && r.costCenter !== '*');
      expect(perDept.length, entity).toBe(NINE_COST_CENTERS);
      const lab = perDept.find((r) => r.costCenter === 'LAB');
      expect(lab?.accountName).toBe('COGS - Payroll Expense:COGS - Lab Wages');
      expect(lab?.memo).toBe('Lab Wages');
      const admin = perDept.find((r) => r.costCenter === 'ADMIN');
      expect(admin?.accountName).toBe('Payroll Expense -:Administrative Wages');
      expect(admin?.memo).toBe('Admin Wages');
    }
  });

  it('MEDICAL - ER keeps its single * Health credit to the withholdings pool (credit side unchanged)', () => {
    for (const entity of POSTABLE_ENTITIES) {
      const credits = buildSeedAccountMap(entity).filter((r) => r.adpColumn === 'MEDICAL - ER' && r.postingType === 'Credit');
      expect(credits).toHaveLength(1);
      expect(credits[0]?.costCenter).toBe('*');
      expect(credits[0]?.accountName).toBe('Payroll Withholdings');
      expect(credits[0]?.creditBucket).toBe('Health');
    }
  });

  it('end-to-end: MEDICAL - ER for two departments splits Accrued Payroll Liability into two memo lines', () => {
    const baseRow = (over: Partial<PayrollRow>): PayrollRow => ({
      position_id: '1', name: 'X', status: 'Active', worker_classification: 'W-2 General Employee',
      home_department: 'ADMIN-Administration', location: 'MEDFL-MedRock FL', pay_date: '07/17/2026', pay_num: '1',
      pay_frequency: 'BI-WEEKLY', pay_group: 'MRFL', pay_type: 'Regular', period_start_date: '07/01/2026',
      period_end_date: '07/14/2026', processed_as: 'Bi-Weekly Payroll', rate_type: 'Hourly', sui_sdi_tax_code: 'FL',
      row_key: 'rk', updated_at: 'x', sensitive: {}, ...over,
    });
    const rows = [
      baseRow({ position_id: 'a', row_key: 'a', home_department: 'ADMIN-Administration', sensitive: { 'MEDICAL - ER': 500 } }),
      baseRow({ position_id: 'c', row_key: 'c', home_department: 'ACCOUN-Accounting', sensitive: { 'MEDICAL - ER': 300 } }),
    ];
    const map = buildSeedAccountMap('MedRock FL');
    const draft = buildJournal(rows, map, []).drafts[0];
    const accrued = draft?.lines.filter((l) => l.accountName === 'Accrued Payroll Liability' && l.postingType === 'Debit') ?? [];
    expect(accrued).toHaveLength(2); // one per department, same account
    expect(accrued.find((l) => l.memo === 'ER Medical - Admin')?.amount).toBe(500);
    expect(accrued.find((l) => l.memo === 'ER Medical - Accounting')?.amount).toBe(300);
  });
});
