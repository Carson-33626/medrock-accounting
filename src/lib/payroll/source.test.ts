import { describe, it, expect } from 'vitest';
import { FixturePayrollSource } from './source';
describe('FixturePayrollSource', () => {
  it('returns decrypted rows within the range', async () => {
    const src = new FixturePayrollSource();
    const rows = await src.fetchRange('2026-06-15', '2026-06-20');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.pay_date.length === 10)).toBe(true);
    expect(rows[0].sensitive).toHaveProperty('GROSS PAY');
  });
  it('excludes rows outside the range', async () => {
    const src = new FixturePayrollSource();
    const rows = await src.fetchRange('2026-07-01', '2026-07-01');
    expect(rows.every((r) => r.pay_date === '07/01/2026')).toBe(true);
  });
});
