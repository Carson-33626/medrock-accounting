import { describe, it, expect } from 'vitest';
import { parseAdpDate, inRange } from './dates';
describe('adp dates', () => {
  it('parses MM/DD/YYYY', () => {
    expect(parseAdpDate('06/18/2026').toISOString().slice(0, 10)).toBe('2026-06-18');
  });
  it('range is inclusive', () => {
    expect(inRange('06/18/2026', '2026-06-01', '2026-06-30')).toBe(true);
    expect(inRange('07/01/2026', '2026-06-01', '2026-06-30')).toBe(false);
  });
});
