import { describe, it, expect } from 'vitest';
import {
  ACCRUAL_PARAMETERS,
  completenessAt,
  computeAccrual,
  curveIsBorrowed,
  daysBetween,
} from './lab-supplies-accrual';

describe('completenessAt', () => {
  it('matches the fitted curve at its measured points', () => {
    expect(completenessAt('MedRock FL', 30)).toBeCloseTo(0.625, 5);
    expect(completenessAt('MedRock TN', 30)).toBeCloseTo(0.948, 5);
    expect(completenessAt('MedRock TX', 30)).toBeCloseTo(0.752, 5);
  });

  it('interpolates between points rather than stepping', () => {
    // FL: 0.625 at 30d, 0.674 at 45d -> halfway is ~0.6495 at 37-38d.
    const mid = completenessAt('MedRock FL', 37);
    expect(mid).toBeGreaterThan(0.625);
    expect(mid).toBeLessThan(0.674);
  });

  it('scales from zero before the first measured point', () => {
    // A month that ended yesterday is not 51% complete just because the table
    // happens to start at day 7.
    expect(completenessAt('MedRock FL', 0)).toBe(0);
    expect(completenessAt('MedRock FL', 7)).toBeCloseTo(0.512, 5);
    expect(completenessAt('MedRock FL', 3)).toBeLessThan(0.512 / 2 + 0.01);
  });

  it('settles at 100% past the end of the curve', () => {
    expect(completenessAt('MedRock FL', 300)).toBe(1);
    expect(completenessAt('MedRock FL', 900)).toBe(1);
  });

  it('reports TX as borrowing a curve and the others as not', () => {
    expect(curveIsBorrowed('MedRock TX')).toBe(true);
    expect(curveIsBorrowed('MedRock FL')).toBe(false);
    expect(curveIsBorrowed('MedRock TN')).toBe(false);
  });
});

describe('daysBetween', () => {
  it('counts whole days and never goes negative', () => {
    expect(daysBetween('2026-06-30', '2026-07-30')).toBe(30);
    expect(daysBetween('2026-06-30', '2026-06-30')).toBe(0);
    expect(daysBetween('2026-08-31', '2026-06-30')).toBe(0);
  });
});

describe('computeAccrual', () => {
  it('falls back to the historical average when nothing is keyed yet', () => {
    // August 2026: 3 days elapsed, zero documents entered anywhere. With no signal
    // the accrual must equal history, not zero.
    const r = computeAccrual({
      location: 'MedRock FL',
      monthEnd: '2026-08-31',
      asOf: '2026-09-03',
      observedToDate: 0,
      observedDocs: 0,
    });
    expect(r.completeness).toBe(0);
    expect(r.accrual).toBe(3024.06);
    expect(r.estimatedTotal).toBe(3024.06);
  });

  it('shrinks to nothing as a month settles — it reverses, it is not a plug', () => {
    const settled = computeAccrual({
      location: 'MedRock TN',
      monthEnd: '2026-01-31',
      asOf: '2026-12-31',
      observedToDate: 2500,
      observedDocs: 20,
    });
    expect(settled.completeness).toBe(1);
    expect(settled.accrual).toBe(0);
    expect(settled.estimatedTotal).toBe(2500);
  });

  it('lets the ENTRY CLAMP override an over-confident curve — the backlog case', () => {
    // TN June 2026 measured on 2026-09-03: 65 days elapsed, so the curve alone
    // calls it 100% settled and would accrue $0. Only 3 of a normal 15 documents
    // have been keyed, because the accountant's backfill has not reached June.
    const r = computeAccrual({
      location: 'MedRock TN',
      monthEnd: '2026-06-30',
      asOf: '2026-09-03',
      observedToDate: 340,
      observedDocs: 3,
    });
    expect(r.curveCompleteness).toBe(1);
    expect(r.entryCompleteness).toBeCloseTo(3 / 15, 5);
    expect(r.completeness).toBeCloseTo(0.2, 5);
    expect(r.boundBy).toBe('entry');
    // 0.8 x 2469.20 — against the $0 the unclamped curve would have given.
    expect(r.accrual).toBeCloseTo(1975.36, 2);
  });

  it('lets the CURVE bind when entry is running normally', () => {
    const r = computeAccrual({
      location: 'MedRock FL',
      monthEnd: '2026-06-30',
      asOf: '2026-07-30',
      observedToDate: 1900,
      observedDocs: 26,
    });
    expect(r.entryCompleteness).toBe(1);
    expect(r.completeness).toBeCloseTo(0.625, 5);
    expect(r.boundBy).toBe('curve');
  });

  it('flags a month whose estimate falls under half the historical average', () => {
    const r = computeAccrual({
      location: 'MedRock TN',
      monthEnd: '2026-06-30',
      asOf: '2027-06-30',
      observedToDate: 340,
      observedDocs: 15,
    });
    expect(r.completeness).toBe(1);
    expect(r.accrual).toBe(0);
    expect(r.flagged).toBe(true);
    expect(r.flagReason).toContain('review before posting');
  });

  it('does not flag a month that lands near history', () => {
    const r = computeAccrual({
      location: 'MedRock FL',
      monthEnd: '2026-04-30',
      asOf: '2027-04-30',
      observedToDate: 3100,
      observedDocs: 30,
    });
    expect(r.flagged).toBe(false);
    expect(r.flagReason).toBeNull();
  });

  it('never returns a negative accrual, even if a month overshoots history', () => {
    const r = computeAccrual({
      location: 'MedRock FL',
      monthEnd: '2026-03-31',
      asOf: '2026-04-30',
      observedToDate: 99_999,
      observedDocs: 40,
    });
    expect(r.accrual).toBeGreaterThanOrEqual(0);
  });

  it('marks TX as running on a borrowed curve', () => {
    const r = computeAccrual({
      location: 'MedRock TX',
      monthEnd: '2026-07-31',
      asOf: '2026-09-03',
      observedToDate: 273,
      observedDocs: 2,
    });
    expect(r.borrowedCurve).toBe(true);
  });

  it('keeps the published parameters as the research measured them', () => {
    // These are posted-JE inputs. A silent edit here changes what hits the books,
    // so pin them: re-fitting is a deliberate act with a new measurement behind it.
    expect(ACCRUAL_PARAMETERS.trailingAverage['MedRock FL']).toBe(3024.06);
    expect(ACCRUAL_PARAMETERS.trailingAverage['MedRock TN']).toBe(2469.2);
    expect(ACCRUAL_PARAMETERS.trailingAverage['MedRock TX']).toBe(2069.69);
    expect(ACCRUAL_PARAMETERS.normalDocsPerMonth['MedRock FL']).toBe(26);
    expect(ACCRUAL_PARAMETERS.normalDocsPerMonth['MedRock TN']).toBe(15);
    expect(ACCRUAL_PARAMETERS.lowEstimateFlag).toBe(0.5);
  });
});
