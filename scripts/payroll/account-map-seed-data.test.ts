import { describe, it, expect } from 'vitest';
import { buildSeedAccountMap, SEEDED_ENTITIES } from './account-map-seed-data';
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
    for (const entity of SEEDED_ENTITIES) {
      const matches = buildSeedAccountMap(entity).filter((r) => r.adpColumn === COLUMN);
      expect(matches, `${entity} should map ${COLUMN}`).toHaveLength(1);
    }
  });

  it('credits QBO 1215 Employee Advances, not the withholdings pool', () => {
    for (const entity of SEEDED_ENTITIES) {
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
 * Regression cover for the child-support processing fee mapping (Barbara, 2026-08-05) — the
 * remaining ~$2 half of the $252 residual (COMPANY LOAN above was the ~$250 half). An
 * employer-paid fee, so unlike the EE-side 'CHILD PAYMENTS' credit it needs a Debit expense
 * line (QBO 6500.80) plus the standard '*' withholdings-pool credit to stay balanced.
 */
describe('CHILD PAYMENTS - ER', () => {
  const COLUMN = 'CHILD PAYMENTS - ER';

  it('emits NO debit — the fee is withheld from the employee, not paid by the employer', () => {
    // This is the whole point of the 2026-08-07 correction. ADP's "- ER" suffix is misleading:
    // the fee sits inside TOTAL WITHHOLDING ORDERS and comes out of the employee's gross, so an
    // employer expense line is phantom. Booking it as Debit + Credit was also self-balancing and
    // therefore could not close the $2 residual it was added to close — it left every MedRock FL
    // run $2.00 heavy, which in turn blocked the month-boundary split on every straddling run.
    for (const entity of SEEDED_ENTITIES) {
      const debits = buildSeedAccountMap(entity).filter((r) => r.adpColumn === COLUMN && r.postingType === 'Debit');
      expect(debits, `${entity} must not debit an expense for a fee the employee paid`).toHaveLength(0);
    }
  });

  it("credits the ENTITY'S OWN garnishment account, keeping the fee with the location it came from", () => {
    // Barbara, 2026-08-06: "child support pieces/processing fee needs to stay with the location
    // it's from." GARNISHMENT_ACCOUNT is entity-specific, so crediting it (rather than the shared
    // 'Payroll Withholdings' pool) keeps the whole withholding order — the deduction AND the ADP
    // admin fee — in the originating location's liability.
    const expected: Record<string, string> = {
      'MedRock FL': 'Employee Garnishment Liability',
      'MedRock TN': 'Payroll Withholdings',
      'MedRock TX': 'Payroll Withholdings',
      FOCAS: 'Payroll Withholdings',
    };
    for (const entity of SEEDED_ENTITIES) {
      const credits = buildSeedAccountMap(entity).filter((r) => r.adpColumn === COLUMN && r.postingType === 'Credit');
      expect(credits, `${entity} credit`).toHaveLength(1);
      expect(credits[0]?.accountName).toBe(expected[entity]);
      expect(credits[0]?.costCenter).toBe('*');
      expect(credits[0]?.creditBucket).toBe('Garnishments');
      expect(credits[0]?.memo).toBe('Child Support Fee');
    }
  });

  it('lands in the same account as the child-support deduction it belongs to', () => {
    // The fee and the deduction are two parts of ONE withholding order (289.21 + 2.00 = 291.21),
    // so they must not be split across two different liability accounts.
    for (const entity of SEEDED_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      const fee = rules.find((r) => r.adpColumn === COLUMN);
      const deduction = rules.find((r) => r.adpColumn === 'CHILD PAYMENTS' && r.postingType === 'Credit');
      expect(fee?.accountName, `${entity}`).toBe(deduction?.accountName);
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
    for (const entity of SEEDED_ENTITIES) {
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
    for (const entity of SEEDED_ENTITIES) {
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
    for (const entity of SEEDED_ENTITIES) {
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

/**
 * The seed must never emit two identical same-direction rules for one (entity, column, cost
 * centre). resolveLine returns EVERY in-direction match, so a duplicate posts the amount twice.
 * This became a live risk once all three home-state unemployment columns were added to the shared
 * all-states list, since an entity's own state then appears in the composed list twice.
 */
describe('no duplicate rules', () => {
  it('never emits the same (column, cost centre, direction, account) twice', () => {
    for (const entity of SEEDED_ENTITIES) {
      const seen = new Map<string, number>();
      for (const r of buildSeedAccountMap(entity)) {
        const k = [r.adpColumn, r.costCenter, r.postingType, r.accountName].join('¦');
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
      expect(dupes, `${entity} has duplicate rules: ${dupes.join(' / ')}`).toEqual([]);
    }
  });

  it('maps every entity for a home-state unemployment column, not just its own state', () => {
    // MedRock FL really does carry TX unemployment ($72.01) for an employee living in Texas.
    for (const entity of SEEDED_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      for (const state of ['FL', 'TN', 'TX']) {
        const col = `${state} STATE - UNEMPLOYMENT INSURANCE ER`;
        expect(rules.some((r) => r.adpColumn === col), `${entity} should map ${col}`).toBe(true);
      }
    }
  });
});

/**
 * FOCAS became a seeded entity on 2026-08-07, once its QuickBooks company was connected and its
 * chart of accounts was populated from the MedRock FL template. These cover the three ways FOCAS
 * genuinely differs from the other entities — each was derived from its live 2026 ADP rows, and
 * each would silently mis-post if it regressed.
 */
describe('FOCAS seed', () => {
  const focas = buildSeedAccountMap('FOCAS');

  it('is populated', () => {
    expect(focas.length).toBeGreaterThan(0);
    expect(focas.every((r) => r.entity === 'FOCAS')).toBe(true);
  });

  it('maps all THREE state unemployment columns — FOCAS staff sit in FL, TN and TX', () => {
    // A single-state assumption would leave two of the three permanently unmapped.
    for (const column of [
      'FL STATE - UNEMPLOYMENT INSURANCE ER',
      'TN STATE - UNEMPLOYMENT INSURANCE ER',
      'TX STATE - UNEMPLOYMENT INSURANCE ER',
    ]) {
      expect(focas.some((r) => r.adpColumn === column), `FOCAS should map ${column}`).toBe(true);
    }
  });

  it('emits no workers-comp rule — FOCAS carries no WC column in ADP', () => {
    // Borrowing another entity's LLC-named WC column would invent a cost FOCAS does not bear.
    expect(focas.filter((r) => /WORKERS COMPENSATION/i.test(r.adpColumn))).toHaveLength(0);
  });

  it('pools garnishments into Payroll Withholdings rather than a FOCAS-specific liability', () => {
    const garnish = focas.filter((r) => r.creditBucket === 'Garnishments');
    expect(garnish.length).toBeGreaterThan(0);
    for (const r of garnish) expect(r.accountName).toBe('Payroll Withholdings');
  });
});

/**
 * Regression cover for the 2026-08-06 overtime complaint. OT_WAGE_ACCOUNT used to omit
 * PHARM/ADMIN/ACCOUN/MARKET, so those cost centers emitted no OT rule and the column resurfaced
 * as "new columns detected" on nearly every run — FL's ACCOUN staff work overtime on 12 of 17
 * pay dates. Every account asserted here was verified to exist in all four QBO companies.
 */
describe('overtime is mapped for every cost center', () => {
  const OT_COLUMNS = ['OVERTIME PREMIUM - EARNING', 'OVERTIME STRAIGHT - EARNING'];
  const COST_CENTERS = ['LAB', 'PHARM', 'RD', 'ADMIN', 'ACCOUN', 'CS', 'DATA', 'SHIP', 'MARKET'];

  it('leaves no cost center without an OT account', () => {
    for (const entity of SEEDED_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      for (const column of OT_COLUMNS) {
        for (const cc of COST_CENTERS) {
          const hit = rules.find((r) => r.adpColumn === column && r.costCenter === cc);
          expect(hit, `${entity} ${column} ${cc} should have an OT rule`).toBeDefined();
          expect(hit?.postingType).toBe('Debit');
        }
      }
    }
  });

  it('sends ADMIN and ACCOUN overtime to the dedicated administrative OT account', () => {
    // Both share 'Administrative Wages' for regular pay, so they share its OT counterpart
    // (Carson, 2026-08-07) — and this is what the dead '*admin' rules were reaching for.
    for (const entity of SEEDED_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      for (const cc of ['ADMIN', 'ACCOUN']) {
        const hit = rules.find((r) => r.adpColumn === 'OVERTIME STRAIGHT - EARNING' && r.costCenter === cc);
        expect(hit?.accountName).toBe('Payroll Expense -:Administrative - OT Wages');
        expect(hit?.isCogs).toBe(false);
      }
    }
  });
});

/**
 * FMLA - EARNING is a wage earning and must be mapped PER cost center like its siblings. It had
 * been resolved by a hand-made cost_center '*' rule pointing at COGS - Pharmacists Wages, which
 * mis-coded every non-pharmacist's FMLA — FL's MARKET ($8,938), LAB ($3,656) and CS ($2,775),
 * plus TN's LAB, were all landing in Pharmacists COGS.
 */
describe('FMLA - EARNING', () => {
  it('maps per cost center to the same account as regular pay', () => {
    for (const entity of SEEDED_ENTITIES) {
      const rules = buildSeedAccountMap(entity);
      for (const cc of ['LAB', 'PHARM', 'CS', 'MARKET', 'ADMIN']) {
        const fmla = rules.find((r) => r.adpColumn === 'FMLA - EARNING' && r.costCenter === cc);
        const regular = rules.find((r) => r.adpColumn === 'REGULAR PAY - EARNING' && r.costCenter === cc);
        expect(fmla, `${entity} FMLA ${cc}`).toBeDefined();
        expect(fmla?.accountName).toBe(regular?.accountName);
        expect(fmla?.isCogs).toBe(regular?.isCogs);
        expect(fmla?.postingType).toBe('Debit');
      }
    }
  });

  it('never pools every cost center into one account', () => {
    // The exact shape of the bug: a single '*' rule swallowing all cost centers.
    const fl = buildSeedAccountMap('MedRock FL').filter((r) => r.adpColumn === 'FMLA - EARNING');
    const accounts = new Set(fl.map((r) => r.accountName));
    expect(accounts.size).toBeGreaterThan(1);
  });
});
