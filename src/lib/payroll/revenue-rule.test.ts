import { describe, it, expect } from 'vitest';
import { sharesFromPresence, EOM_ENTITIES, type RevenueTest } from './revenue-rule';

const test = (fl: number, tn: number, tx: number): RevenueTest => ({
  month: '2026-03',
  // EOM stays trio-only (EOM_ENTITIES); FOCAS is a placeholder never read by sharesFromPresence.
  income: { 'MedRock FL': fl, 'MedRock TN': tn, 'MedRock TX': tx, 'FOCAS': 0 },
});

describe('sharesFromPresence', () => {
  it('all three have revenue -> equal thirds summing to 100', () => {
    const s = sharesFromPresence(test(100, 200, 300));
    expect(s).not.toBeNull();
    const shares = s as Record<string, number>;
    for (const e of EOM_ENTITIES) expect(shares[e]).toBeCloseTo(100 / 3, 6);
    expect(EOM_ENTITIES.reduce((a, e) => a + shares[e], 0)).toBeCloseTo(100, 6);
  });
  it('one lacks revenue -> 50/50 between the two that have it', () => {
    const s = sharesFromPresence(test(100, 0, 300)) as Record<string, number>;
    expect(s['MedRock FL']).toBe(50);
    expect(s['MedRock TN']).toBe(0);
    expect(s['MedRock TX']).toBe(50);
  });
  it('only one has revenue -> 100% to it', () => {
    const s = sharesFromPresence(test(0, 0, 5)) as Record<string, number>;
    expect(s['MedRock TX']).toBe(100);
    expect(s['MedRock FL']).toBe(0);
  });
  it('negative income does NOT count as revenue', () => {
    const s = sharesFromPresence(test(-10, 100, 0)) as Record<string, number>;
    expect(s['MedRock TN']).toBe(100);
  });
  it('nobody has revenue -> null', () => {
    expect(sharesFromPresence(test(0, 0, 0))).toBeNull();
  });
});
