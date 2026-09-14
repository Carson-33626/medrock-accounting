import { describe, it, expect } from 'vitest';
import { buildLabSuppliesContribution, LAB_SUPPLIES_SOURCE_KEY } from './lab-supplies-contribution';
import type { LabSuppliesAccrualMonth } from './lab-supplies-server';

function row(month: string, accrual: number, extra: Partial<LabSuppliesAccrualMonth> = {}): LabSuppliesAccrualMonth {
  return {
    location: 'MedRock Florida',
    month,
    observedToDate: 1000,
    observedDocs: 4,
    daysElapsed: 14,
    curveCompleteness: 0.6,
    entryCompleteness: 0.5,
    completeness: 0.5,
    boundBy: 'entry',
    trailingAverage: 3000,
    accrual,
    estimatedTotal: 1000 + accrual,
    flagged: false,
    flagReason: null,
    borrowedCurve: false,
    ...extra,
  } as LabSuppliesAccrualMonth;
}

const base = { location: 'MedRock Florida', month: '2026-08', monthEnded: true, available: true };

describe('buildLabSuppliesContribution — target vs posted, inside the close entry', () => {
  it('books Dr 5000.25 / Cr 2011 for target minus posted, tagged for later query', () => {
    const c = buildLabSuppliesContribution({
      ...base,
      months: [row('2026-07', 400), row('2026-08', 1500), row('2026-09', 3000) /* future, ignored */],
      postedToDate: 700,
    });
    expect(c.target).toBe(1900);
    expect(c.delta).toBe(1200);
    expect(c.available).toBe(true);
    expect(c.lines).toHaveLength(2);
    const [expense, liability] = c.lines;
    expect(expense.postingType).toBe('Debit');
    expect(expense.accountName).toBe('Cost of Goods Sold:Lab Supplies');
    expect(expense.amount).toBe(1200);
    expect(liability.postingType).toBe('Credit');
    expect(liability.accountName).toBe('Accrued Expenses');
    expect(liability.amount).toBe(1200);
    expect(expense.sourceRowKeys).toEqual([LAB_SUPPLIES_SOURCE_KEY]);
    expect(expense.memo).toContain('$1900.00');
    expect(expense.memo).toContain('$700.00');
    expect(c.basis.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
  });

  it('flips the lines when bills have landed and the posted balance is now too high', () => {
    const c = buildLabSuppliesContribution({ ...base, months: [row('2026-08', 100)], postedToDate: 900 });
    expect(c.delta).toBe(-800);
    expect(c.lines[0]).toMatchObject({ postingType: 'Credit', accountName: 'Cost of Goods Sold:Lab Supplies', amount: 800 });
    expect(c.lines[1]).toMatchObject({ postingType: 'Debit', accountName: 'Accrued Expenses', amount: 800 });
  });

  it('emits no lines when the target already stands, but stays available with its target', () => {
    const c = buildLabSuppliesContribution({ ...base, months: [row('2026-08', 500)], postedToDate: 500 });
    expect(c.lines).toEqual([]);
    expect(c.available).toBe(true);
    expect(c.target).toBe(500);
    expect(c.delta).toBe(0);
  });

  it('ignores other locations', () => {
    const other = row('2026-08', 9999, { location: 'MedRock Tennessee' as LabSuppliesAccrualMonth['location'] });
    const c = buildLabSuppliesContribution({ ...base, months: [other, row('2026-08', 250)], postedToDate: 0 });
    expect(c.target).toBe(250);
  });

  it('refuses to accrue a month that has not ended — no lines, a warning, still available', () => {
    const c = buildLabSuppliesContribution({ ...base, months: [row('2026-08', 3000)], postedToDate: 0, monthEnded: false });
    expect(c.lines).toEqual([]);
    expect(c.available).toBe(true);
    expect(c.warnings[0]).toContain('has not ended');
  });

  it('is unavailable when QuickBooks could not be read, so the pool blocks posting', () => {
    const c = buildLabSuppliesContribution({ ...base, months: [], postedToDate: 0, available: false });
    expect(c.available).toBe(false);
    expect(c.lines).toEqual([]);
    expect(c.warnings[0]).toContain('could not be read');
  });

  it('surfaces a flagged month as a warning without dropping it from the target', () => {
    const c = buildLabSuppliesContribution({
      ...base,
      months: [row('2026-08', 100, { flagged: true, flagReason: 'implausibly low against history' })],
      postedToDate: 0,
    });
    expect(c.target).toBe(100);
    expect(c.warnings).toEqual(['MedRock Florida 2026-08: implausibly low against history']);
  });
});
