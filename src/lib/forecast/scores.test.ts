import { describe, it, expect } from 'vitest';
import { rankMethods, accuracyPct } from './scores';
import type { EntityMethodScore } from './types';

const row = (entity: string, method: EntityMethodScore['method'], abs: number, act: number): EntityMethodScore =>
  ({ entity, method, absErrSum: abs, actualSum: act, holdoutMonths: 3, trainable: true });

describe('rankMethods', () => {
  it('volume-weights WAPE across entities and flags the lowest as recommended', () => {
    const scores: EntityMethodScore[] = [
      row('FL', 'holt-winters', 100, 1000), // 10%
      row('TN', 'holt-winters', 100, 1000), // 10% → aggregate 200/2000 = 10%
      row('FL', 'linear-trend', 300, 1000), // 30%
      row('TN', 'linear-trend', 300, 1000), // aggregate 30%
    ];
    const ranked = rankMethods(scores, new Set());
    const hw = ranked.find((r) => r.method === 'holt-winters')!;
    const lt = ranked.find((r) => r.method === 'linear-trend')!;
    expect(hw.wape).toBeCloseTo(10, 5);
    expect(lt.wape).toBeCloseTo(30, 5);
    expect(hw.recommended).toBe(true);
    expect(lt.recommended).toBe(false);
  });
  it('bigger entity dominates the aggregate', () => {
    const scores: EntityMethodScore[] = [
      row('FL', 'ses', 10, 10000),  // small error on a big base
      row('TN', 'ses', 90, 100),    // big error on a tiny base → 100/10100 ≈ 0.99%
    ];
    const ranked = rankMethods(scores, new Set());
    expect(ranked.find((r) => r.method === 'ses')!.wape).toBeCloseTo((100 / 10100) * 100, 5);
  });
});

describe('accuracyPct', () => {
  it('is 100 - WAPE, clamped at 0', () => {
    expect(accuracyPct(10)).toBe(90);
    expect(accuracyPct(140)).toBe(0);
  });
});
