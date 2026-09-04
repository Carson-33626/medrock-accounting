import { describe, expect, it } from 'vitest';
import {
  completenessAt,
  computeShippingAccrual,
  curveIsBorrowed,
  daysBetween,
  monthEndOf,
  shiftMonth,
  trailingAverageWindow,
  SETTLE_DAYS,
  TRAILING_MONTHS,
  type ShippingAccrualInput,
} from './shipping-packaging-accrual';

/** A settled, unremarkable month — override one field per test. */
function input(over: Partial<ShippingAccrualInput> = {}): ShippingAccrualInput {
  return {
    location: 'MedRock FL',
    monthEnd: '2026-06-30',
    asOf: '2026-09-04',
    observedToDate: 8780,
    observedDocs: 3,
    trailingAverage: 6106.07,
    activeMonths: 12,
    ...over,
  };
}

describe('date helpers', () => {
  it('monthEndOf handles a leap February', () => {
    expect(monthEndOf('2026-02')).toBe('2026-02-28');
    expect(monthEndOf('2024-02')).toBe('2024-02-29');
    expect(monthEndOf('2026-12')).toBe('2026-12-31');
  });

  it('shiftMonth crosses a year boundary', () => {
    expect(shiftMonth('2026-01', 1)).toBe('2025-12');
    expect(shiftMonth('2026-01', 13)).toBe('2024-12');
    expect(shiftMonth('2026-06', 0)).toBe('2026-06');
  });

  it('daysBetween never goes negative', () => {
    expect(daysBetween('2026-06-30', '2026-09-04')).toBe(66);
    expect(daysBetween('2026-09-04', '2026-06-30')).toBe(0);
  });
});

describe('completeness curve', () => {
  it('scales from zero before the first curve point', () => {
    // A month that ended yesterday is not 74% complete just because the curve
    // starts at day 7.
    expect(completenessAt('MedRock FL', 0)).toBe(0);
    expect(completenessAt('MedRock FL', 7)).toBeCloseTo(0.74, 5);
    expect(completenessAt('MedRock FL', 3.5)).toBeCloseTo(0.37, 5);
  });

  it('interpolates between points', () => {
    // FL 30d = 0.931, 45d = 0.994; halfway is 37.5d.
    expect(completenessAt('MedRock FL', 37.5)).toBeCloseTo(0.9625, 4);
  });

  it('reaches and holds 100% by SETTLE_DAYS in every location', () => {
    for (const loc of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const) {
      expect(completenessAt(loc, SETTLE_DAYS)).toBe(1);
      expect(completenessAt(loc, 400)).toBe(1);
    }
  });

  it('is monotonically non-decreasing — a month cannot un-settle', () => {
    for (const loc of ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const) {
      let prev = -1;
      for (let d = 0; d <= 320; d += 1) {
        const c = completenessAt(loc, d);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
  });

  it('settles far faster than the lab-supplies curve — this is the point of refitting', () => {
    // Lab supplies' FL curve is 62.5% at 30 days and does not reach 100% until 300.
    // 1220.30 is a handful of large vendor bills, not a daily Amazon dribble.
    expect(completenessAt('MedRock FL', 30)).toBeGreaterThan(0.9);
    expect(completenessAt('MedRock TN', 45)).toBe(1);
  });

  it('only TX borrows a curve', () => {
    expect(curveIsBorrowed('MedRock TX')).toBe(true);
    expect(curveIsBorrowed('MedRock FL')).toBe(false);
    expect(curveIsBorrowed('MedRock TN')).toBe(false);
  });
});

describe('trailingAverageWindow', () => {
  it('ends at the last SETTLED month, not at asOf', () => {
    // 2026-09-04: August ended 4 days ago and July 35 — neither has settled at
    // SETTLE_DAYS = 60. June (66 days) has.
    const w = trailingAverageWindow('2026-09-04');
    expect(w).toHaveLength(TRAILING_MONTHS);
    expect(w[w.length - 1]).toBe('2026-06');
    expect(w[0]).toBe('2025-07');
  });

  it('is contiguous and oldest-first', () => {
    const w = trailingAverageWindow('2026-09-04');
    for (let i = 1; i < w.length; i += 1) {
      expect(shiftMonth(w[i], 1)).toBe(w[i - 1]);
    }
  });

  it('every month in the window has itself settled', () => {
    const asOf = '2026-09-04';
    for (const m of trailingAverageWindow(asOf)) {
      expect(daysBetween(monthEndOf(m), asOf)).toBeGreaterThanOrEqual(SETTLE_DAYS);
    }
  });
});

describe('computeShippingAccrual', () => {
  it('accrues nothing for a fully settled month', () => {
    // FL 2026-06 on 2026-09-04: 66 days elapsed, curve at 100%.
    const r = computeShippingAccrual(input());
    expect(r.daysElapsed).toBe(66);
    expect(r.curveCompleteness).toBe(1);
    expect(r.accrual).toBe(0);
    expect(r.estimatedTotal).toBe(8780);
    expect(r.flagged).toBe(false);
  });

  it('accrues (1 - completeness) x the trailing average', () => {
    // 21 days elapsed in FL -> 0.884 complete.
    const r = computeShippingAccrual(
      input({ monthEnd: '2026-06-30', asOf: '2026-07-21', observedToDate: 4000, observedDocs: 2 }),
    );
    expect(r.curveCompleteness).toBeCloseTo(0.884, 5);
    expect(r.accrual).toBe(708.3); // (1 - 0.884) * 6106.07 = 708.304
    expect(r.estimatedTotal).toBe(4708.3);
  });

  it('ZERO-ENTRY OVERRIDE: no documents keyed means a full month accrues', () => {
    // TN 2026-08 on 2026-09-04 — zero 1220.30 documents. The curve, reading four
    // elapsed days, would call it ~46% done off nothing at all.
    const r = computeShippingAccrual(
      input({
        location: 'MedRock TN',
        monthEnd: '2026-08-31',
        asOf: '2026-09-04',
        observedToDate: 0,
        observedDocs: 0,
        trailingAverage: 4858.41,
      }),
    );
    expect(r.curveCompleteness).toBeGreaterThan(0.4);
    expect(r.zeroEntryOverride).toBe(true);
    expect(r.completeness).toBe(0);
    expect(r.accrual).toBe(4858.41);
  });

  it('one document keyed is enough to let the curve decide again', () => {
    const r = computeShippingAccrual(
      input({ monthEnd: '2026-08-31', asOf: '2026-09-04', observedToDate: 960, observedDocs: 1 }),
    );
    expect(r.zeroEntryOverride).toBe(false);
    expect(r.completeness).toBe(r.curveCompleteness);
    expect(r.accrual).toBeLessThan(6106.07);
  });

  it('does NOT clamp proportionally on document count — the lab-supplies clamp is wrong here', () => {
    // One $7,002 label order IS the whole month. Lab supplies' clamp
    // (observedDocs / normalDocsPerMonth) would call this 25% complete against a
    // 4-document median and accrue 75% of the average on top of an above-average
    // month. Measured and rejected.
    const r = computeShippingAccrual(
      input({ monthEnd: '2026-03-31', asOf: '2026-09-04', observedToDate: 7002, observedDocs: 1 }),
    );
    expect(r.accrual).toBe(0);
  });

  it('never returns a negative accrual, even against a negative average', () => {
    const r = computeShippingAccrual(input({ trailingAverage: -100, observedDocs: 0 }));
    expect(r.accrual).toBe(0);
  });

  it('flags a month whose estimate lands under half the trailing average', () => {
    // FL 2026-05: $1,232.21 keyed, 96 days old so the curve calls it settled — but
    // its median entry lag was 106 days, so "settled" is exactly what to doubt.
    const r = computeShippingAccrual(
      input({ monthEnd: '2026-05-31', asOf: '2026-09-04', observedToDate: 1232.21, observedDocs: 10 }),
    );
    expect(r.accrual).toBe(0);
    expect(r.flagged).toBe(true);
    expect(r.flagReason).toContain('under half');
  });

  it('flags thin history and says so separately', () => {
    const r = computeShippingAccrual(
      input({
        location: 'MedRock TX',
        monthEnd: '2026-07-31',
        asOf: '2026-09-04',
        observedToDate: 631.36,
        observedDocs: 1,
        trailingAverage: 315.77,
        activeMonths: 5,
      }),
    );
    expect(r.thinHistory).toBe(true);
    expect(r.borrowedCurve).toBe(true);
    expect(r.flagged).toBe(true);
    expect(r.flagReason).toContain('5 of the 12 trailing months');
  });

  it('does not raise the low-estimate flag when there is no baseline to compare against', () => {
    const r = computeShippingAccrual(
      input({ trailingAverage: 0, activeMonths: 12, observedToDate: 0, observedDocs: 2 }),
    );
    expect(r.accrual).toBe(0);
    expect(r.flagged).toBe(false);
  });

  it('rounds to whole cents', () => {
    const r = computeShippingAccrual(
      input({ monthEnd: '2026-06-30', asOf: '2026-07-10', observedDocs: 1, trailingAverage: 1000 }),
    );
    expect(Math.round(r.accrual * 100)).toBe(r.accrual * 100);
    expect(Math.round(r.estimatedTotal * 100)).toBe(r.estimatedTotal * 100);
  });
});
