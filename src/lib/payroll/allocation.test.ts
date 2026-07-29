import { describe, it, expect } from 'vitest';
import { assertSharesSumTo100, largestRemainderCents } from './allocation';

describe('assertSharesSumTo100', () => {
  it('accepts three thirds at 4dp', () => {
    expect(() => assertSharesSumTo100([33.3333, 33.3333, 33.3334])).not.toThrow();
  });
  it('accepts an even split', () => {
    expect(() => assertSharesSumTo100([50, 50])).not.toThrow();
  });
  it('rejects a set that does not sum to 100', () => {
    expect(() => assertSharesSumTo100([33.3333, 33.3333, 33.3333])).toThrow(/sum to 100/);
    expect(() => assertSharesSumTo100([40, 40, 40])).toThrow(/sum to 100/);
  });
});

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
