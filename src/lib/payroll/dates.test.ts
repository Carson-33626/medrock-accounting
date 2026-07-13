import { describe, it, expect } from 'vitest';
import { parseAdpDate, inRange, adpDateToIso } from './dates';
describe('adp dates', () => {
  it('parses MM/DD/YYYY', () => {
    expect(parseAdpDate('06/18/2026').toISOString().slice(0, 10)).toBe('2026-06-18');
  });
  it('range is inclusive', () => {
    expect(inRange('06/18/2026', '2026-06-01', '2026-06-30')).toBe(true);
    expect(inRange('07/01/2026', '2026-06-01', '2026-06-30')).toBe(false);
  });
  it('converts MM/DD/YYYY to ISO YYYY-MM-DD', () => {
    expect(adpDateToIso('06/18/2026')).toBe('2026-06-18');
  });
  it('zero-pads non-padded month/day when converting to ISO', () => {
    expect(adpDateToIso('6/1/2026')).toBe('2026-06-01');
  });
});
