import { describe, it, expect } from 'vitest';
import { largestRemainderCents } from './allocation';

describe('largestRemainderCents', () => {
  it('splits an indivisible total so the parts re-sum exactly', () => {
    // $100.00 == 10000c, thirds -> 3333 + 3333 + 3334
    const parts = largestRemainderCents(10000, [33.3333, 33.3333, 33.3334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts.sort((a, b) => a - b)).toEqual([3333, 3333, 3334]);
  });
  it('handles an exact split with no remainder', () => {
    expect(largestRemainderCents(9000, [50, 50])).toEqual([4500, 4500]);
  });
  it('returns zeros for a zero total', () => {
    expect(largestRemainderCents(0, [33.3333, 33.3333, 33.3334])).toEqual([0, 0, 0]);
  });
});
