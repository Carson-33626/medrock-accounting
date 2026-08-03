import { describe, it, expect } from 'vitest';
import { resolveSince, PERIOD_FLOOR } from './cli-args';

// Carson's rule (2026-08-03): never write to a closed period. The floor tracks the accounting
// team's open month (May as of 2026-08-03), so it is a hard refusal rather than a default a flag
// can quietly undercut. Tests assert against PERIOD_FLOOR, not a literal, so advancing the floor
// as months close does not require rewriting them.
describe('resolveSince', () => {
  it('sits at or after the start of 2026', () => {
    expect(PERIOD_FLOOR >= '2026-01-01').toBe(true);
  });

  it('defaults to the period floor when no --since is given', () => {
    expect(resolveSince(null)).toBe(PERIOD_FLOOR);
  });

  it('accepts a date on the floor', () => {
    expect(resolveSince(PERIOD_FLOOR)).toBe(PERIOD_FLOOR);
  });

  it('accepts a date after the floor', () => {
    expect(resolveSince('2026-07-01')).toBe('2026-07-01');
  });

  it('refuses a date before the floor rather than silently clamping', () => {
    expect(() => resolveSince('2025-09-01')).toThrow(/closed period/i);
  });

  it('refuses a date inside a month that has since been closed', () => {
    expect(() => resolveSince('2026-01-01')).toThrow(/closed period/i);
  });

  it('refuses a malformed date', () => {
    expect(() => resolveSince('09/01/2025')).toThrow(/YYYY-MM-DD/i);
  });
});
