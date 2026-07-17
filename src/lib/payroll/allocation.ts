import type { Entity, AllocationRule } from './types';

/** Throws unless the percents sum to 100.0000 (4dp tolerance). No silent normalisation. */
export function assertSharesSumTo100(percents: number[]): void {
  const sum = percents.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.0001) {
    throw new Error(`allocation percents must sum to 100, got ${sum.toFixed(4)}`);
  }
}

/**
 * Split `totalCents` across `weights` (percentages) by the largest-remainder method: floor each
 * proportional share, then hand the leftover cents one at a time to the largest fractional
 * remainders. The result sums to `totalCents` EXACTLY, so 33.3333 × 3 never leaves a stray cent.
 */
export function largestRemainderCents(totalCents: number, weights: number[]): number[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (totalCents === 0 || wsum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / wsum);
  const floors = exact.map((x) => Math.floor(x));
  let remaining = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < order.length && remaining > 0; k++) { out[order[k].i]++; remaining--; }
  return out;
}
