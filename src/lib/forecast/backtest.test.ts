// web/src/lib/forecast/backtest.test.ts
import { describe, it, expect } from 'vitest';
import { scoreEntity, buildScores } from './backtest';
import { fmtMonth } from './engine';
import type { DataPoint } from './types';

function series(values: number[]): DataPoint[] {
  return values.map((v, i) => {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return { label: fmtMonth(m, y), sortKey: y * 100 + m, count: v, isProjected: false };
  });
}

describe('scoreEntity', () => {
  it('produces WAPE components for trainable methods over the hold-out', () => {
    const s = series(Array.from({ length: 24 }, (_, i) => 1000 + i * 20));
    // Anchor 6 months back → 6-month hold-out. cmk beyond the series so nothing is treated as current.
    const anchorKey = s[s.length - 7].sortKey;
    const scores = scoreEntity(s, anchorKey, 999912);
    expect(scores['linear-trend'].trainable).toBe(true);
    expect(scores['linear-trend'].holdoutMonths).toBe(6);
    expect(scores['linear-trend'].actualSum).toBeGreaterThan(0);
    expect(scores['linear-trend'].absErrSum).toBeGreaterThanOrEqual(0);
  });
  it('marks a method untrainable when the hold-out is empty (anchor = last month)', () => {
    const s = series(Array.from({ length: 24 }, (_, i) => 1000 + i * 20));
    const scores = scoreEntity(s, s[s.length - 1].sortKey, 999912);
    expect(scores['linear-trend'].trainable).toBe(false);
    expect(scores['linear-trend'].holdoutMonths).toBe(0);
  });
});

describe('buildScores', () => {
  it('emits one row per (entity, method)', () => {
    const map = new Map<string, DataPoint[]>([
      ['MedRock FL', series(Array.from({ length: 24 }, (_, i) => 2000 + i * 30))],
      ['MedRock TN', series(Array.from({ length: 24 }, (_, i) => 1500 + i * 10))],
    ]);
    const anchorKey = 999900; // out of range → resolves to last complete index (no hold-out)
    const rows = buildScores(map, anchorKey, 999912);
    expect(rows).toHaveLength(2 * 5); // 2 entities × 5 methods
    expect(new Set(rows.map((r) => r.entity)).size).toBe(2);
  });
});
