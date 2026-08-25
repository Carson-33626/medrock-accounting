import { describe, it, expect } from 'vitest';
import { sharesFromRevenue, EOM_ENTITIES, type RevenueTest } from './revenue-rule';

const test = (fl: number, tn: number, tx: number): RevenueTest => ({
  month: '2026-03',
  income: { 'MedRock FL': fl, 'MedRock TN': tn, 'MedRock TX': tx },
});

describe('sharesFromRevenue', () => {
  it('weights each location by its share of total revenue', () => {
    const s = sharesFromRevenue(test(100, 200, 300)) as Record<string, number>;
    expect(s['MedRock FL']).toBeCloseTo(16.666667, 5);
    expect(s['MedRock TN']).toBeCloseTo(33.333333, 5);
    expect(s['MedRock TX']).toBeCloseTo(50, 6);
    expect(EOM_ENTITIES.reduce((a, e) => a + s[e], 0)).toBeCloseTo(100, 6);
  });

  it('equal revenue still yields equal shares', () => {
    const s = sharesFromRevenue(test(500, 500, 500)) as Record<string, number>;
    for (const e of EOM_ENTITIES) expect(s[e]).toBeCloseTo(100 / 3, 6);
  });

  it('is NOT the old presence rule: unequal revenue must not come out as thirds', () => {
    const s = sharesFromRevenue(test(926310.6, 1100379.47, 116366.02)) as Record<string, number>;
    expect(s['MedRock FL']).toBeCloseTo(43.22, 2);
    expect(s['MedRock TN']).toBeCloseTo(51.35, 2);
    expect(s['MedRock TX']).toBeCloseTo(5.43, 2);
    for (const e of EOM_ENTITIES) expect(Math.abs(s[e] - 100 / 3)).toBeGreaterThan(1);
  });

  it('reproduces Amy October 2025: FL 50.14% of a two-entity pool', () => {
    // FL $926,972.48 / TN $921,883.63 -> the real 2025-10 revenue split behind PR ALLO 2025.10.
    const s = sharesFromRevenue(test(926972.48, 921883.63, 0)) as Record<string, number>;
    expect(s['MedRock FL']).toBeCloseTo(50.14, 2);
    expect(s['MedRock TN']).toBeCloseTo(49.86, 2);
    expect(s['MedRock TX']).toBe(0);
  });

  it('a location with no revenue takes no share', () => {
    const s = sharesFromRevenue(test(100, 0, 300)) as Record<string, number>;
    expect(s['MedRock FL']).toBeCloseTo(25, 6);
    expect(s['MedRock TN']).toBe(0);
    expect(s['MedRock TX']).toBeCloseTo(75, 6);
  });

  it('only one location has revenue -> 100% to it', () => {
    const s = sharesFromRevenue(test(0, 0, 5)) as Record<string, number>;
    expect(s['MedRock TX']).toBe(100);
    expect(s['MedRock FL']).toBe(0);
  });

  it('negative income clamps to zero rather than inverting the split', () => {
    const s = sharesFromRevenue(test(-10, 100, 0)) as Record<string, number>;
    expect(s['MedRock FL']).toBe(0);
    expect(s['MedRock TN']).toBe(100);
  });

  it('nobody has revenue -> null', () => {
    expect(sharesFromRevenue(test(0, 0, 0))).toBeNull();
  });

  it('all-negative -> null rather than a nonsense split', () => {
    expect(sharesFromRevenue(test(-5, -10, -1))).toBeNull();
  });
});
