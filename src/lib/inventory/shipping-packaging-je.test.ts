import { describe, expect, it } from 'vitest';
import { assemblePool } from './je-pool';
import {
  ACCRUED_EXPENSES_ACCOUNT,
  SHIPPING_ACCRUAL_PAY_GROUP,
  SHIPPING_EXPENSE_ACCOUNT,
  buildShippingAccrualDrafts,
  buildShippingAccrualLines,
  buildShippingContribution,
  monthEndIso,
  monthTag,
  nextMonthStartIso,
  shippingAccrualIdentity,
  type ShippingAccrualDraftInput,
} from './shipping-packaging-je';
import type { ShippingAccrualResult } from './shipping-packaging-accrual';

function draftInput(over: Partial<ShippingAccrualDraftInput> = {}): ShippingAccrualDraftInput {
  return {
    location: 'MedRock FL',
    month: '2026-08',
    accrual: 6106.07,
    completeness: 0,
    zeroEntryOverride: true,
    ...over,
  };
}

function result(over: Partial<ShippingAccrualResult> = {}): ShippingAccrualResult {
  return {
    daysElapsed: 4,
    curveCompleteness: 0.42,
    completeness: 0,
    zeroEntryOverride: true,
    trailingAverage: 6106.07,
    accrual: 6106.07,
    estimatedTotal: 6106.07,
    flagged: false,
    flagReason: null,
    borrowedCurve: false,
    thinHistory: false,
    ...over,
  };
}

describe('date helpers', () => {
  it('monthTag matches the DocNumber convention the other kinds use', () => {
    expect(monthTag('2026-08')).toBe('2026.08');
  });

  it('monthEndIso and nextMonthStartIso are adjacent, across a year boundary', () => {
    expect(monthEndIso('2026-12')).toBe('2026-12-31');
    expect(nextMonthStartIso('2026-12')).toBe('2027-01-01');
    expect(monthEndIso('2026-02')).toBe('2026-02-28');
  });
});

describe('shippingAccrualIdentity', () => {
  it('dates the accrual at month-end and the reversal on the first of the next month', () => {
    expect(shippingAccrualIdentity('2026-08', 'accrual').txnDateIso).toBe('2026-08-31');
    expect(shippingAccrualIdentity('2026-08', 'reversal').txnDateIso).toBe('2026-09-01');
  });

  it('gives the reversal an R-suffixed DocNumber that names its accrual', () => {
    const a = shippingAccrualIdentity('2026-08', 'accrual');
    const r = shippingAccrualIdentity('2026-08', 'reversal');
    expect(a.docNumber).toBe('SP Accru 2026.08');
    expect(r.docNumber).toBe('SP Accru 2026.08R');
    expect(r.privateNote).toContain(a.docNumber);
  });

  it('does not collide with the lab-supplies DocNumber scheme', () => {
    expect(shippingAccrualIdentity('2026-08', 'accrual').docNumber).not.toBe('LS Accru 2026.08');
  });
});

describe('buildShippingAccrualLines', () => {
  it('debits 5000.20 and credits 2011 — never the inventory asset', () => {
    const lines = buildShippingAccrualLines(draftInput());
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.postingType === 'Debit');
    const credit = lines.find((l) => l.postingType === 'Credit');
    expect(debit?.accountName).toBe(SHIPPING_EXPENSE_ACCOUNT);
    expect(credit?.accountName).toBe(ACCRUED_EXPENSES_ACCOUNT);
    // Crediting the asset would drive 1220.30 negative on top of the close.
    expect(lines.some((l) => l.accountName.includes('Inventory'))).toBe(false);
  });

  it('uses FullyQualifiedNames — a bare account number resolves to nothing', () => {
    for (const l of buildShippingAccrualLines(draftInput())) {
      expect(l.accountName).not.toMatch(/^\d/);
    }
    expect(SHIPPING_EXPENSE_ACCOUNT).toBe('Cost of Goods Sold:Final Packaging Materials');
  });

  it('flips both sides for the reversal', () => {
    const lines = buildShippingAccrualLines(draftInput(), true);
    expect(lines.find((l) => l.accountName === SHIPPING_EXPENSE_ACCOUNT)?.postingType).toBe('Credit');
    expect(lines.find((l) => l.accountName === ACCRUED_EXPENSES_ACCOUNT)?.postingType).toBe('Debit');
  });

  it('says WHY the number is what it is, in the memo', () => {
    expect(buildShippingAccrualLines(draftInput())[0].memo).toContain('no documents keyed yet');
    expect(
      buildShippingAccrualLines(draftInput({ zeroEntryOverride: false, completeness: 0.884 }))[0]
        .memo,
    ).toContain('88% complete');
  });

  it('produces no lines at zero or below', () => {
    expect(buildShippingAccrualLines(draftInput({ accrual: 0 }))).toHaveLength(0);
    expect(buildShippingAccrualLines(draftInput({ accrual: -5 }))).toHaveLength(0);
    expect(buildShippingAccrualLines(draftInput({ accrual: 0.004 }))).toHaveLength(0);
  });
});

describe('buildShippingAccrualDrafts', () => {
  it('builds a balanced pair on its own pay_group', () => {
    const pair = buildShippingAccrualDrafts(draftInput());
    expect(pair).not.toBeNull();
    if (pair === null) return;
    for (const half of [pair.accrual, pair.reversal]) {
      expect(half.payGroup).toBe(SHIPPING_ACCRUAL_PAY_GROUP);
      expect(half.totalDebits).toBe(half.totalCredits);
      expect(half.variance).toBe(0);
      expect(half.entity).toBe('MedRock FL');
      expect(half.periodStart).toBe('2026-08-01');
      expect(half.periodEnd).toBe('2026-08-31');
    }
  });

  it('gives the two halves DIFFERENT pay dates — saveDraft would upsert them together', () => {
    // saveDraft's natural key is (entity, pay_date, pay_group, period_segment);
    // `kind` is NOT in it, so a shared pay_date loses the accrual.
    const pair = buildShippingAccrualDrafts(draftInput());
    if (pair === null) throw new Error('expected a pair');
    expect(pair.accrual.payDate).toBe('08/31/2026');
    expect(pair.reversal.payDate).toBe('09/01/2026');
    expect(pair.accrual.payDate).not.toBe(pair.reversal.payDate);
  });

  it('consecutive months cannot collide either', () => {
    const july = buildShippingAccrualDrafts(draftInput({ month: '2026-07' }));
    const august = buildShippingAccrualDrafts(draftInput({ month: '2026-08' }));
    if (july === null || august === null) throw new Error('expected pairs');
    const dates = [
      july.accrual.payDate,
      july.reversal.payDate,
      august.accrual.payDate,
      august.reversal.payDate,
    ];
    expect(new Set(dates).size).toBe(4);
  });

  it('the reversal exactly undoes the accrual', () => {
    const pair = buildShippingAccrualDrafts(draftInput());
    if (pair === null) throw new Error('expected a pair');
    const net = new Map<string, number>();
    for (const half of [pair.accrual, pair.reversal]) {
      for (const l of half.lines) {
        const sign = l.postingType === 'Debit' ? 1 : -1;
        net.set(l.accountName, (net.get(l.accountName) ?? 0) + sign * l.amount);
      }
    }
    for (const [, v] of net) expect(v).toBe(0);
  });

  it('rounds the amount onto both lines identically', () => {
    const pair = buildShippingAccrualDrafts(draftInput({ accrual: 1234.5649 }));
    if (pair === null) throw new Error('expected a pair');
    expect(pair.accrual.totalDebits).toBe(1234.56);
    for (const l of pair.accrual.lines) expect(l.amount).toBe(1234.56);
  });

  it('returns null rather than a shelf of $0.00 entries', () => {
    expect(buildShippingAccrualDrafts(draftInput({ accrual: 0 }))).toBeNull();
    expect(buildShippingAccrualDrafts(draftInput({ accrual: -1 }))).toBeNull();
  });
});

describe('buildShippingContribution', () => {
  it('satisfies JeContribution and assembles into a balanced pool', () => {
    const c = buildShippingContribution({
      location: 'MedRock FL',
      month: '2026-08',
      result: result(),
    });
    expect(c.source).toBe('shipping-packaging');
    expect(c.available).toBe(true);
    const pool = assemblePool([c]);
    expect(pool.variance).toBe(0);
    expect(pool.postable).toBe(true);
    expect(pool.subtotals[0].debits).toBe(6106.07);
    expect(pool.subtotals[0].credits).toBe(6106.07);
  });

  it('contributes the ACCRUAL half only — the reversal belongs to the next month', () => {
    const c = buildShippingContribution({
      location: 'MedRock FL',
      month: '2026-08',
      result: result(),
    });
    expect(c.lines).toHaveLength(2);
    expect(c.lines.find((l) => l.accountName === SHIPPING_EXPENSE_ACCOUNT)?.postingType).toBe(
      'Debit',
    );
  });

  it('an unreadable realm is unavailable and blocks the pool from posting', () => {
    const c = buildShippingContribution({ location: 'MedRock TN', month: '2026-08', result: null });
    expect(c.available).toBe(false);
    expect(c.lines).toHaveLength(0);
    expect(c.warnings[0]).toContain('QuickBooks could not be read');
    const pool = assemblePool([c]);
    expect(pool.unavailable).toEqual(['shipping-packaging']);
    expect(pool.postable).toBe(false);
  });

  it('"ran, nothing to accrue" stays available and distinguishable from "never ran"', () => {
    const c = buildShippingContribution({
      location: 'MedRock FL',
      month: '2026-06',
      result: result({ accrual: 0, completeness: 1, zeroEntryOverride: false, estimatedTotal: 8780 }),
    });
    expect(c.available).toBe(true);
    expect(c.lines).toHaveLength(0);
    const pool = assemblePool([c]);
    expect(pool.subtotals).toHaveLength(1);
    expect(pool.subtotals[0].lineCount).toBe(0);
  });

  it('surfaces the flag reason and the borrowed curve as warnings, never swallows them', () => {
    const c = buildShippingContribution({
      location: 'MedRock TX',
      month: '2026-07',
      result: result({
        accrual: 0,
        flagged: true,
        flagReason: 'Only 5 of the 12 trailing months carry any 1220.30 activity',
        borrowedCurve: true,
        thinHistory: true,
      }),
    });
    expect(c.warnings).toHaveLength(2);
    expect(c.warnings.join(' ')).toContain('5 of the 12 trailing months');
    expect(c.warnings.join(' ')).toContain('pooled FL+TN curve');
    // A warning does not make it unavailable — a flagged number still shows.
    expect(c.available).toBe(true);
  });
});
