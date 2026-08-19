import { describe, it, expect } from 'vitest';
import { isPayrollPeriodComplete, isEomMonthComplete } from './period-locks';

describe('isPayrollPeriodComplete', () => {
  it('locks pay dates before 04/10/2026', () => {
    expect(isPayrollPeriodComplete('03/27/2026')).toBe(true);
    expect(isPayrollPeriodComplete('01/21/2026')).toBe(true);
    expect(isPayrollPeriodComplete('12/31/2025')).toBe(true);
  });
  it('leaves 04/10/2026 (the first system-posted payroll) and later open', () => {
    expect(isPayrollPeriodComplete('04/10/2026')).toBe(false);
    expect(isPayrollPeriodComplete('04/24/2026')).toBe(false);
    expect(isPayrollPeriodComplete('07/17/2026')).toBe(false);
  });
  it('never locks a malformed date — a lock must not hide a data bug', () => {
    expect(isPayrollPeriodComplete('')).toBe(false);
    expect(isPayrollPeriodComplete('2026-03-27')).toBe(false);
    expect(isPayrollPeriodComplete('3/27/26')).toBe(false);
  });
});

describe('isEomMonthComplete', () => {
  it('locks allocation months through March 2026', () => {
    expect(isEomMonthComplete('2026-01')).toBe(true);
    expect(isEomMonthComplete('2026-02')).toBe(true);
    expect(isEomMonthComplete('2026-03')).toBe(true);
    expect(isEomMonthComplete('2025-12')).toBe(true);
  });
  it('leaves April 2026 onward open', () => {
    expect(isEomMonthComplete('2026-04')).toBe(false);
    expect(isEomMonthComplete('2026-12')).toBe(false);
  });
  it('never locks a malformed month', () => {
    expect(isEomMonthComplete('March 2026')).toBe(false);
    expect(isEomMonthComplete('2026-13')).toBe(false);
  });
});
