import { describe, it, expect } from 'vitest';
import {
  buildSeasonal, linearTrend, holtWinters, resolveMethod, seasonalNaive,
  trimLeadingRampUp, forecastEntity, fmtMonth,
} from './engine';
import type { DataPoint } from './types';

// Helper: dense monthly series starting Jan 2024.
function series(values: number[]): DataPoint[] {
  return values.map((v, i) => {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return { label: fmtMonth(m, y), sortKey: y * 100 + m, count: v, isProjected: false };
  });
}

describe('fmtMonth', () => {
  it('formats as YYYY-MM', () => {
    expect(fmtMonth(3, 2026)).toBe('2026-03');
    expect(fmtMonth(11, 2026)).toBe('2026-11');
  });
});

describe('resolveMethod (no tiering)', () => {
  it('keeps holt-winters when >=18 months available', () => {
    expect(resolveMethod('holt-winters', 24)).toBe('holt-winters');
  });
  it('falls back off holt-winters when <18 months', () => {
    expect(resolveMethod('holt-winters', 5)).toBe('weighted-avg');
  });
  it('falls back to seasonal-naive when even weighted-avg lacks data', () => {
    expect(resolveMethod('linear-trend', 0)).toBe('seasonal-naive');
  });
});

describe('linearTrend on dollars', () => {
  it('projects a rising line and preserves negative-capable output', () => {
    const s = series([100, 110, 120, 130, 140, 150]);
    const out = linearTrend(s, 3, s.length - 1);
    expect(out.projected).toHaveLength(3);
    expect(out.projected[0].count).toBeGreaterThan(150);
    expect(out.projected[2].count).toBeGreaterThan(out.projected[0].count);
  });
  it('does NOT clamp a declining series at zero (loss months allowed)', () => {
    const s = series([200, 100, 0, -100, -200, -300]);
    const out = linearTrend(s, 2, s.length - 1);
    expect(out.projected[0].count).toBeLessThan(0);
  });
});

describe('buildSeasonal', () => {
  it('returns a 12-length index averaging ~1', () => {
    const s = series([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const { seasonalIdx } = buildSeasonal(s, s.length - 1);
    expect(seasonalIdx).toHaveLength(12);
    const mean = seasonalIdx.reduce((a, b) => a + b, 0) / 12;
    expect(mean).toBeCloseTo(1, 1);
  });
});

describe('holtWinters', () => {
  it('needs >=18 months and projects with seasonality', () => {
    const base = Array.from({ length: 24 }, (_, i) => 1000 + i * 10 + (i % 12 === 11 ? 300 : 0));
    const s = series(base);
    const out = holtWinters(s, 6, s.length - 1);
    expect(out.projected).toHaveLength(6);
    expect(out.projected.every((p) => Number.isFinite(p.count))).toBe(true);
  });
});

describe('trimLeadingRampUp', () => {
  it('drops a pre-opening near-zero prefix', () => {
    const s = series([2, 3, 1, 500, 520, 540]);
    const trimmed = trimLeadingRampUp(s, 540);
    expect(trimmed[0].count).toBe(500);
    expect(trimmed).toHaveLength(3);
  });
});

describe('forecastEntity', () => {
  it('labels a fallback when history is short', () => {
    const s = series([100, 120, 140, 160, 180]); // 5 mo → HW unavailable
    const ef = forecastEntity('MedRock TX', s, 3, 'holt-winters', 202512);
    expect(ef.forecastMethod).toContain('→');
    expect(ef.projected).toHaveLength(3);
  });
});
