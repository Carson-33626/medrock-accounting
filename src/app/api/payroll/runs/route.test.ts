import { describe, it, expect } from 'vitest';
import { selectSource } from '../../../../lib/payroll/source-select';

describe('selectSource', () => {
  it('falls back to fixture when key absent', () => {
    delete process.env.PAYROLL_ENC_KEY;
    expect(selectSource().constructor.name).toBe('FixturePayrollSource');
  });
});
