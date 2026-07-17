import { describe, it, expect } from 'vitest';
import { assertSharesSumTo100, largestRemainderCents, buildAllocation, resolveEffectiveShares } from './allocation';
import type { AllocationRule, Entity } from './types';
import type { Month } from './month';

describe('assertSharesSumTo100', () => {
  it('accepts three thirds at 4dp', () => {
    expect(() => assertSharesSumTo100([33.3333, 33.3333, 33.3334])).not.toThrow();
  });
  it('accepts an even split', () => {
    expect(() => assertSharesSumTo100([50, 50])).not.toThrow();
  });
  it('rejects a set that does not sum to 100', () => {
    expect(() => assertSharesSumTo100([33.3333, 33.3333, 33.3333])).toThrow(/sum to 100/);
    expect(() => assertSharesSumTo100([40, 40, 40])).toThrow(/sum to 100/);
  });
});

describe('largestRemainderCents', () => {
  it('splits an indivisible total so the parts re-sum exactly', () => {
    // $100.00 == 10000c, thirds -> 3333 + 3333 + 3334
    const parts = largestRemainderCents(10000, [33.3333, 33.3333, 33.3334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts.sort((a, b) => a - b)).toEqual([3333, 3333, 3334]);
  });
  it('handles an exact split with no remainder', () => {
    expect(largestRemainderCents(9000, [50, 50])).toEqual([4500, 4500]);
  });
  it('returns zeros for a zero total', () => {
    expect(largestRemainderCents(0, [33.3333, 33.3333, 33.3334])).toEqual([0, 0, 0]);
  });
});

const JUN: Month = { year: 2026, month: 6 };
const thirds = (from: string): AllocationRule[] =>
  (['MedRock FL', 'MedRock TN', 'MedRock TX'] as Entity[]).map((e, i) => ({
    costCenter: 'ADMIN', targetEntity: e, percent: i === 2 ? 33.3334 : 33.3333, effectiveFrom: from, active: true,
  }));

describe('resolveEffectiveShares', () => {
  it('returns null for a month before the earliest rule (go-forward gate)', () => {
    expect(resolveEffectiveShares(thirds('2026-07-01'), 'ADMIN', JUN)).toBeNull();
  });
  it('picks the latest effective rule per entity', () => {
    const rules = [...thirds('2026-01-01'),
      { costCenter: 'ADMIN', targetEntity: 'MedRock FL' as Entity, percent: 50, effectiveFrom: '2026-06-01', active: true },
      { costCenter: 'ADMIN', targetEntity: 'MedRock TN' as Entity, percent: 25, effectiveFrom: '2026-06-01', active: true },
      { costCenter: 'ADMIN', targetEntity: 'MedRock TX' as Entity, percent: 25, effectiveFrom: '2026-06-01', active: true }];
    expect(resolveEffectiveShares(rules, 'ADMIN', JUN)).toEqual({ 'MedRock FL': 50, 'MedRock TN': 25, 'MedRock TX': 25 });
  });
});

describe('buildAllocation', () => {
  it('returns [] when no rule is effective for the month', () => {
    expect(buildAllocation({ 'MedRock FL': 3000, 'MedRock TN': 3000, 'MedRock TX': 3000 }, thirds('2026-07-01'), JUN)).toEqual([]);
  });

  it('is all-zero (no drafts) when actuals already match the split', () => {
    const drafts = buildAllocation({ 'MedRock FL': 3000, 'MedRock TN': 3000, 'MedRock TX': 3000 }, thirds('2026-01-01'), JUN);
    expect(drafts).toEqual([]);
  });

  it('moves cost to the hub with balanced legs and Δs summing to zero', () => {
    // FL carries all $9,000 of admin wages; TN and TX carry none. Target = 3000 each.
    const drafts = buildAllocation({ 'MedRock FL': 9000, 'MedRock TN': 0, 'MedRock TX': 0 }, thirds('2026-01-01'), JUN);
    const byEnt = Object.fromEntries(drafts.map((d) => [d.entity, d]));

    // TN picks up 3000: debit Admin Wages / credit Due to Medrock Pharmacy, LLC
    const tn = byEnt['MedRock TN'];
    expect(tn.docNumber).toBe('TN % Allo 2026.06');
    expect(tn.txnDate).toBe('2026-06-30');
    expect(tn.lines.find((l) => l.accountName.includes('Administrative Wages'))).toMatchObject({ postingType: 'Debit', amount: 3000 });
    expect(tn.lines.find((l) => l.accountName === 'Due to Medrock Pharmacy, LLC')).toMatchObject({ postingType: 'Credit', amount: 3000 });
    expect(tn.totalDebits).toBeCloseTo(tn.totalCredits, 10);

    // TX picks up 3000 against the ", LLC"-less FL account
    const tx = byEnt['MedRock TX'];
    expect(tx.docNumber).toBe('TX % Allo 2026.06');
    expect(tx.lines.find((l) => l.accountName === 'Due to Medrock Pharmacy')).toMatchObject({ postingType: 'Credit', amount: 3000 });
    expect(tx.totalDebits).toBeCloseTo(tx.totalCredits, 10);

    // FL sheds 6000: credit Admin Wages 6000; debit Due from TN 3000 + Due from TX 3000
    const fl = byEnt['MedRock FL'];
    expect(fl.lines.find((l) => l.accountName.includes('Administrative Wages'))).toMatchObject({ postingType: 'Credit', amount: 6000 });
    expect(fl.lines.find((l) => l.accountName === 'Due from MedRock TN, LLC')).toMatchObject({ postingType: 'Debit', amount: 3000 });
    expect(fl.lines.find((l) => l.accountName === 'Due From MedRock TX, LLC')).toMatchObject({ postingType: 'Debit', amount: 3000 });
    expect(fl.totalDebits).toBeCloseTo(fl.totalCredits, 10);

    // Δs sum to zero
    const totalMoved = drafts.reduce((s, d) => s + d.totalDebits - d.totalCredits, 0);
    expect(totalMoved).toBeCloseTo(0, 10);
  });

  it('re-sums to T exactly on an indivisible total (largest-remainder)', () => {
    // T = 100.00, FL holds it all; targets 33.33/33.33/33.34
    const drafts = buildAllocation({ 'MedRock FL': 100, 'MedRock TN': 0, 'MedRock TX': 0 }, thirds('2026-01-01'), JUN);
    const tn = drafts.find((d) => d.entity === 'MedRock TN')!;
    const tx = drafts.find((d) => d.entity === 'MedRock TX')!;
    const fl = drafts.find((d) => d.entity === 'MedRock FL')!;
    const admin = (d: typeof fl): number => d.lines.find((l) => l.accountName.includes('Administrative Wages'))!.amount;
    // FL sheds exactly what TN+TX pick up, to the penny
    expect(admin(tn) + admin(tx)).toBeCloseTo(admin(fl), 10);
  });

  it('carries Amy dimensions on every line', () => {
    const drafts = buildAllocation({ 'MedRock FL': 9000, 'MedRock TN': 0, 'MedRock TX': 0 }, thirds('2026-01-01'), JUN);
    for (const d of drafts) for (const l of d.lines) {
      expect(l.departmentName).toBe('% Allocation');
      expect(l.className).toBe('Allocate - %');
      expect(l.memo).toBe('% Allocation - Admin Wages');
    }
  });
});
