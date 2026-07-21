import { describe, it, expect } from 'vitest';
import { parseMonthToken, parseAmountToken, parseClipboard } from './manual-forecast-paste';

describe('parseMonthToken', () => {
  it('parses many shapes to a sortKey', () => {
    expect(parseMonthToken('2026-08')).toBe(202608);
    expect(parseMonthToken('8/2026')).toBe(202608);
    expect(parseMonthToken('Aug 2026')).toBe(202608);
    expect(parseMonthToken('garbage')).toBeNull();
  });
});
describe('parseAmountToken', () => {
  it('strips currency and allows negatives', () => {
    expect(parseAmountToken('$1,200')).toBe(1200);
    expect(parseAmountToken('-2000')).toBe(-2000);
  });
});
describe('parseClipboard', () => {
  it('parses month+amount pairs from a TSV paste', () => {
    const r = parseClipboard('2026-08\t500000\n2026-09\t520000');
    expect(r.kind).toBe('pairs');
    if (r.kind === 'pairs') expect(r.pairs).toHaveLength(2);
  });
  it('parses a single amount column', () => {
    const r = parseClipboard('500000\n520000\n540000');
    expect(r.kind).toBe('amounts');
    if (r.kind === 'amounts') expect(r.amounts).toHaveLength(3);
  });
});
