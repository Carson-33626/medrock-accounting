import { describe, it, expect } from 'vitest';
import { collectOrderIds, composeMemo } from './amazon-memo';

describe('collectOrderIds', () => {
  it('finds 3-7-7 order ids in free text', () => {
    expect(collectOrderIds(['Details for Order #111-2233445-6677889 blah'])).toEqual(['111-2233445-6677889']);
  });
  it('dedupes across sources, preserving first-seen order', () => {
    expect(collectOrderIds([
      'Amazon order# 111-2233445-6677889',
      'order 222-0000000-1111111 and 111-2233445-6677889 again',
    ])).toEqual(['111-2233445-6677889', '222-0000000-1111111']);
  });
  it('ignores nulls and near-miss shapes', () => {
    expect(collectOrderIds([null, undefined, '12-3456789-1234567', '1234-567-89'])).toEqual([]);
  });
});

describe('composeMemo', () => {
  it('returns null when there are no ids', () => {
    expect(composeMemo([], 'keep me')).toBeNull();
  });
  it('returns just the order line when there is no prior memo', () => {
    expect(composeMemo(['111-2233445-6677889'], null)).toBe('Amazon order# 111-2233445-6677889');
    expect(composeMemo(['111-2233445-6677889'], '   ')).toBe('Amazon order# 111-2233445-6677889');
  });
  it('prepends, preserving existing human text on the next line', () => {
    expect(composeMemo(['111-2233445-6677889'], 'lab supplies for TN'))
      .toBe('Amazon order# 111-2233445-6677889\nlab supplies for TN');
  });
  it('space-separates multiple ids', () => {
    expect(composeMemo(['111-2233445-6677889', '222-0000000-1111111'], null))
      .toBe('Amazon order# 111-2233445-6677889 222-0000000-1111111');
  });
  it('skips the write when the prior memo already contains every id', () => {
    expect(composeMemo(['111-2233445-6677889'], 'Amazon order# 111-2233445-6677889\nnotes')).toBeNull();
  });
  it('prepends only the MISSING ids when some are already present', () => {
    expect(composeMemo(['111-2233445-6677889', '222-0000000-1111111'], 'Amazon order# 111-2233445-6677889'))
      .toBe('Amazon order# 222-0000000-1111111\nAmazon order# 111-2233445-6677889');
  });
});
