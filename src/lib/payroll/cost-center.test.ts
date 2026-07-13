import { describe, it, expect } from 'vitest';
import { costCenterFor } from './cost-center';

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
