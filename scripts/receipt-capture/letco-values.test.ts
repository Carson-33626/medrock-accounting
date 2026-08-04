import { describe, it, expect } from 'vitest';
import { parseMoneyCents, parsePortalDate } from './letco-values';

describe('parseMoneyCents', () => {
  it('parses a thousands-separated dollar amount to cents', () => {
    expect(parseMoneyCents('$5,164.98')).toBe(516498);
  });
  it('parses a bare amount', () => {
    expect(parseMoneyCents('125.00')).toBe(12500);
  });
  it('parses zero', () => {
    expect(parseMoneyCents('$0.00')).toBe(0);
  });
  it('returns null for non-money text rather than NaN', () => {
    expect(parseMoneyCents('')).toBeNull();
    expect(parseMoneyCents('n/a')).toBeNull();
  });
  it('does not lose the cent on values that float-round badly', () => {
    expect(parseMoneyCents('$1,234.56')).toBe(123456);
    expect(parseMoneyCents('$0.07')).toBe(7);
  });
});

describe('parsePortalDate', () => {
  it('converts M/D/YYYY to YYYY-MM-DD', () => {
    expect(parsePortalDate('8/4/2026')).toBe('2026-08-04');
  });
  it('handles already-padded input', () => {
    expect(parsePortalDate('12/25/2026')).toBe('2026-12-25');
  });
  it('returns null on unrecognised input rather than guessing', () => {
    expect(parsePortalDate('')).toBeNull();
    expect(parsePortalDate('2026-08-04')).toBeNull();
  });
});
