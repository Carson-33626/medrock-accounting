import { describe, it, expect } from 'vitest';
import {
  monthTag, monthEndIso, nextMonthStartIso, monthEndAdp,
  shortMonthName, longMonthName, overlapsMonth, type Month,
} from './month';

const JUN: Month = { year: 2026, month: 6 };
const DEC: Month = { year: 2025, month: 12 };

describe('month helpers', () => {
  it('formats the DocNumber month tag zero-padded', () => {
    expect(monthTag(JUN)).toBe('2026.06');
    expect(monthTag(DEC)).toBe('2025.12');
  });
  it('gives the last calendar day as the accrual TxnDate', () => {
    expect(monthEndIso(JUN)).toBe('2026-06-30');
    expect(monthEndIso(DEC)).toBe('2025-12-31');
    expect(monthEndIso({ year: 2026, month: 2 })).toBe('2026-02-28');
  });
  it('rolls to the first of the next month for the reversal TxnDate', () => {
    expect(nextMonthStartIso(JUN)).toBe('2026-07-01');
    expect(nextMonthStartIso(DEC)).toBe('2026-01-01');
  });
  it('gives an ADP-format month end', () => {
    expect(monthEndAdp(JUN)).toBe('06/30/2026');
  });
  it('names the month short and long', () => {
    expect(shortMonthName(JUN)).toBe('Jun');
    expect(longMonthName(JUN)).toBe('June');
  });
  it('detects period/month overlap inclusively', () => {
    expect(overlapsMonth('06/22/2026', '07/05/2026', JUN)).toBe(true);  // straddles into July
    expect(overlapsMonth('06/17/2026', '06/30/2026', JUN)).toBe(true);  // wholly inside
    expect(overlapsMonth('07/01/2026', '07/14/2026', JUN)).toBe(false); // entirely after
    expect(overlapsMonth('05/20/2026', '06/01/2026', JUN)).toBe(true);  // touches the first
  });
});
