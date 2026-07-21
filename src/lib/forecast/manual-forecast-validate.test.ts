import { describe, it, expect } from 'vitest';
import { validateManualForecastInput } from './manual-forecast-validate';

const good = {
  name: 'FY26 Budget', metric: 'revenue', basis: 'Accrual',
  entries: [{ location: 'MedRock FL', sortKey: 202608, amount: 500000 }],
};

describe('validateManualForecastInput', () => {
  it('accepts a well-formed body', () => {
    const r = validateManualForecastInput(good);
    expect(r.ok).toBe(true);
  });
  it('collects every problem at once', () => {
    const r = validateManualForecastInput({ name: '', metric: 'x', basis: 'y', entries: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  it('rejects an invalid month in sortKey', () => {
    const r = validateManualForecastInput({ ...good, entries: [{ location: 'FL', sortKey: 202613, amount: 1 }] });
    expect(r.ok).toBe(false);
  });
  it('allows negative dollar amounts (loss scenarios)', () => {
    const r = validateManualForecastInput({ ...good, entries: [{ location: 'FL', sortKey: 202608, amount: -2000 }] });
    expect(r.ok).toBe(true);
  });
  it('rejects duplicate (location, sortKey) pairs', () => {
    const r = validateManualForecastInput({ ...good, entries: [
      { location: 'FL', sortKey: 202608, amount: 1 },
      { location: 'FL', sortKey: 202608, amount: 2 },
    ] });
    expect(r.ok).toBe(false);
  });
});
