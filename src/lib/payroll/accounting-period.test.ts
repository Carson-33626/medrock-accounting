import { describe, it, expect } from 'vitest';
import { periodToRange } from './accounting-period';

describe('periodToRange', () => {
  it('month → first through last day, month-name label', () => {
    expect(periodToRange('month', 2026, { month: 7 })).toEqual({ start: '2026-07-01', end: '2026-07-31', label: 'July 2026' });
  });

  it('month → correct last day for February (non-leap)', () => {
    expect(periodToRange('month', 2026, { month: 2 })).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('month → 29 days for a leap February', () => {
    expect(periodToRange('month', 2024, { month: 2 })).toMatchObject({ end: '2024-02-29' });
  });

  it('quarter → the three-month span, Q label', () => {
    expect(periodToRange('quarter', 2026, { quarter: 3 })).toEqual({ start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026' });
    expect(periodToRange('quarter', 2026, { quarter: 1 })).toMatchObject({ start: '2026-01-01', end: '2026-03-31' });
    expect(periodToRange('quarter', 2026, { quarter: 4 })).toMatchObject({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('year → full calendar year, year label', () => {
    expect(periodToRange('year', 2026)).toEqual({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
  });

  it('builds ISO bounds without timezone drift (string-formatted, not toISOString)', () => {
    // A UTC+ machine would shift a local-midnight Date back a day via toISOString; assert the
    // exact first-of-month string regardless of the runner's timezone.
    expect(periodToRange('month', 2026, { month: 1 }).start).toBe('2026-01-01');
  });
});
