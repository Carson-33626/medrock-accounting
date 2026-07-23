import { describe, it, expect } from 'vitest';
import { costCenterFor, deptLabelFor, DEPT_LABEL } from './cost-center';

describe('costCenterFor', () => {
  it('takes the token before the first hyphen, uppercased', () => {
    expect(costCenterFor('LAB-Lab')).toBe('LAB');
  });
  it('takes a longer prefix token the same way', () => {
    expect(costCenterFor('ACCOUN-Accounting')).toBe('ACCOUN');
  });
  it('uppercases a bare value with no hyphen', () => {
    expect(costCenterFor('marketing')).toBe('MARKETING');
  });
  it('falls back to DFLT for an empty string', () => {
    expect(costCenterFor('')).toBe('DFLT');
  });
  it('falls back to DFLT for null', () => {
    expect(costCenterFor(null)).toBe('DFLT');
  });
  it('falls back to DFLT for undefined', () => {
    expect(costCenterFor(undefined)).toBe('DFLT');
  });
});

describe('deptLabelFor', () => {
  it('returns the human label for each known cost center', () => {
    expect(deptLabelFor('PHARM')).toBe('Pharmacists');
    expect(deptLabelFor('CS')).toBe('CSR');
    expect(deptLabelFor('ADMIN')).toBe('Admin');
    expect(deptLabelFor('ACCOUN')).toBe('Accounting');
  });
  it('returns null for DFLT (blank/unknown home_department)', () => {
    expect(deptLabelFor('DFLT')).toBeNull();
  });
  it('returns null for an unrecognized cost center', () => {
    expect(deptLabelFor('NOPE')).toBeNull();
  });
  it('DEPT_LABEL covers all nine known cost centers', () => {
    expect(Object.keys(DEPT_LABEL).sort()).toEqual(
      ['ACCOUN', 'ADMIN', 'CS', 'DATA', 'LAB', 'MARKET', 'PHARM', 'RD', 'SHIP'].sort(),
    );
  });
});
