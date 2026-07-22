import { describe, it, expect } from 'vitest';
import { isTxnEnriched } from './client';

describe('isTxnEnriched', () => {
  it('false for the default single seed line (memo null)', () => {
    expect(isTxnEnriched([{ memo: null }])).toBe(false);
  });
  it('true for a multi-line split', () => {
    expect(isTxnEnriched([{ memo: null }, { memo: null }])).toBe(true);
  });
  it('true for a single line carrying a product memo', () => {
    expect(isTxnEnriched([{ memo: 'Widget, blue' }])).toBe(true);
  });
  it('false for non-array / empty', () => {
    expect(isTxnEnriched(null)).toBe(false);
    expect(isTxnEnriched([])).toBe(false);
  });
});
