import { describe, it, expect } from 'vitest';
import { ieAccountFor } from './inter-entity';

describe('ieAccountFor', () => {
  it('returns FL-held receivables against TN and TX', () => {
    expect(ieAccountFor('MedRock FL', 'MedRock TN')).toBe('Due from MedRock TN, LLC');
    expect(ieAccountFor('MedRock FL', 'MedRock TX')).toBe('Due From MedRock TX, LLC');
  });
  it('returns TN-held payable to FL (the hub) with its ", LLC"', () => {
    expect(ieAccountFor('MedRock TN', 'MedRock FL')).toBe('Due to Medrock Pharmacy, LLC');
  });
  it('returns TX-held payable to FL WITHOUT ", LLC" — the non-derivable gotcha', () => {
    expect(ieAccountFor('MedRock TX', 'MedRock FL')).toBe('Due to Medrock Pharmacy');
  });
  it('returns the TX↔TN legs (defined but unused in v1)', () => {
    expect(ieAccountFor('MedRock TN', 'MedRock TX')).toBe('Due From MedRock TX, LLC');
    expect(ieAccountFor('MedRock TX', 'MedRock TN')).toBe('Due to Medrock Tennessee');
  });
  it('throws for a single entity (no self account)', () => {
    expect(() => ieAccountFor('MedRock FL', 'MedRock FL')).toThrow(/single entity/);
  });
});
