import { describe, it, expect } from 'vitest';
import {
  ACCRUED_EXPENSES_ACCOUNT,
  LAB_SUPPLIES_EXPENSE_ACCOUNT,
  buildLabAccrualDrafts,
  monthEndIso,
  nextMonthStartIso,
} from './lab-supplies-je';

const base = {
  location: 'MedRock TN' as const,
  month: '2026-06',
  accrual: 1975.36,
  completeness: 0.2,
  boundBy: 'entry' as const,
};

describe('month arithmetic', () => {
  it('lands on the real month end, including February', () => {
    expect(monthEndIso('2026-06')).toBe('2026-06-30');
    expect(monthEndIso('2026-02')).toBe('2026-02-28');
    expect(monthEndIso('2024-02')).toBe('2024-02-29');
    expect(monthEndIso('2026-12')).toBe('2026-12-31');
  });

  it('rolls the reversal into the next month, across a year boundary', () => {
    expect(nextMonthStartIso('2026-06')).toBe('2026-07-01');
    expect(nextMonthStartIso('2026-12')).toBe('2027-01-01');
  });
});

describe('buildLabAccrualDrafts', () => {
  it('debits lab supplies COGS and credits the accrued LIABILITY, not inventory', () => {
    // Crediting 1220.20 is right for relieving stranded inventory (the close
    // already does that) and wrong for an accrual — there is no asset to relieve
    // for a bill nobody has keyed, so it would drive 1220.20 negative monthly.
    const { accrual } = buildLabAccrualDrafts(base)!;
    const debit = accrual.lines.find((l) => l.postingType === 'Debit')!;
    const credit = accrual.lines.find((l) => l.postingType === 'Credit')!;

    expect(debit.accountName).toBe(LAB_SUPPLIES_EXPENSE_ACCOUNT);
    expect(credit.accountName).toBe(ACCRUED_EXPENSES_ACCOUNT);
    expect(credit.accountName).not.toMatch(/Inventory/);
  });

  it('uses the FullyQualifiedName form QuickBooks indexes accounts by', () => {
    // A bare '5000.25' resolves to nothing and silently makes the entry
    // unpostable — how the 2026-08-24 close JEs broke.
    expect(LAB_SUPPLIES_EXPENSE_ACCOUNT).toBe('Cost of Goods Sold:Lab Supplies');
    expect(LAB_SUPPLIES_EXPENSE_ACCOUNT).not.toMatch(/^\d/);
  });

  it('balances, and reverses exactly', () => {
    const { accrual, reversal } = buildLabAccrualDrafts(base)!;

    expect(accrual.totalDebits).toBe(1975.36);
    expect(accrual.totalCredits).toBe(1975.36);
    expect(accrual.variance).toBe(0);

    for (const line of accrual.lines) {
      const mirror = reversal.lines.find((l) => l.accountName === line.accountName)!;
      expect(mirror.amount).toBe(line.amount);
      expect(mirror.postingType).not.toBe(line.postingType);
    }
  });

  it('gives the two halves DIFFERENT pay dates — they share a natural key otherwise', () => {
    // saveDraft upserts on (entity, pay_date, pay_group, period_segment); `kind`
    // is not in that key, so a shared pay_date means the reversal overwrites the
    // accrual and only one of the pair survives.
    const { accrual, reversal } = buildLabAccrualDrafts(base)!;
    expect(accrual.payDate).toBe('06/30/2026');
    expect(reversal.payDate).toBe('07/01/2026');
    expect(accrual.payDate).not.toBe(reversal.payDate);
    expect(accrual.payGroup).toBe(reversal.payGroup);
  });

  it('cannot collide with the following month either', () => {
    const june = buildLabAccrualDrafts(base)!;
    const july = buildLabAccrualDrafts({ ...base, month: '2026-07' })!;
    const keys = [june.accrual, june.reversal, july.accrual, july.reversal].map(
      (d) => `${d.entity}|${d.payDate}|${d.payGroup}|${d.periodSegment ?? ''}`,
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('posts the accrual at month end and the reversal on the first', () => {
    const { accrual, reversal } = buildLabAccrualDrafts(base)!;
    expect(accrual.txnDate).toBe('2026-06-30');
    expect(reversal.txnDate).toBe('2026-07-01');
    expect(accrual.kind).toBe('accrual');
    expect(reversal.kind).toBe('reversal');
  });

  it('marks the reversal with the R suffix the other kinds use', () => {
    const { accrual, reversal } = buildLabAccrualDrafts(base)!;
    expect(accrual.docNumber).toBe('LS Accru 2026.06');
    expect(reversal.docNumber).toBe('LS Accru 2026.06R');
    expect(reversal.privateNote).toContain('LS Accru 2026.06');
  });

  it('says in the memo WHICH measure bound the estimate', () => {
    const entryBound = buildLabAccrualDrafts(base)!;
    expect(entryBound.accrual.lines[0].memo).toContain('20% of documents keyed');

    const curveBound = buildLabAccrualDrafts({ ...base, boundBy: 'curve', completeness: 0.625 })!;
    expect(curveBound.accrual.lines[0].memo).toContain('63% complete for its age');
  });

  it('builds nothing when a month has settled and there is nothing to accrue', () => {
    // A shelf of balanced $0.00 entries is noise an accountant has to read past
    // every month to find the real ones.
    expect(buildLabAccrualDrafts({ ...base, accrual: 0 })).toBeNull();
    expect(buildLabAccrualDrafts({ ...base, accrual: -12 })).toBeNull();
  });

  it('routes each location to its own posting entity', () => {
    expect(buildLabAccrualDrafts({ ...base, location: 'MedRock FL' })!.accrual.entity).toBe('MedRock FL');
    expect(buildLabAccrualDrafts({ ...base, location: 'MedRock TX' })!.accrual.entity).toBe('MedRock TX');
  });
});
