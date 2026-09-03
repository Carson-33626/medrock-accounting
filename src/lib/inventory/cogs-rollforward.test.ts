import { describe, it, expect } from 'vitest';
import {
  buildCogsRollForward,
  movementLocations,
  movementToCogsRows,
  priorCalendarMonth,
} from './cogs-rollforward';
import type { CategoryLedgerMovementRow } from '@/types/inventory';

const row = (
  month: string,
  location: string,
  qbCategory: string,
  endingValue: number,
  purchasesValue: number,
  consumedValue: number,
): CategoryLedgerMovementRow => ({
  month,
  location,
  qbCategory,
  endingValue,
  purchasesValue,
  consumedValue,
});

const FL = 'MedRock Florida';
const TN = 'MedRock Tennessee';
const TX = 'MedRock Texas';

/**
 * A miniature of the real shape: a cutover January, two normal months, a Texas
 * that starts trading in March with no predecessor, a Florida category that is
 * emptied out during March, a Tennessee whose prior month consumed nothing, and a
 * negative true-up month.
 */
const MOVEMENT: CategoryLedgerMovementRow[] = [
  row('2026-01', FL, 'Commercial Rx', 1_000, 500, 300),
  row('2026-02', FL, 'Commercial Rx', 1_200, 800, 550),
  row('2026-02', FL, 'Compound Ingredient', 200, 100, 90),
  row('2026-02', TN, 'Commercial Rx', 50, 50, 0),
  row('2026-03', FL, 'Commercial Rx', 1_100, 400, 480),
  row('2026-03', TN, 'Commercial Rx', 30, 0, 20),
  row('2026-03', TX, 'Commercial Rx', 700, 900, 200),
  row('2026-08', FL, 'Commercial Rx', 800, 100, 200),
  row('2026-09', FL, 'Commercial Rx', 900, 0, -120),
];

const ALL = { location: 'all', firstAnchoredMonth: '2026-01' };

describe('priorCalendarMonth', () => {
  it('steps back a month and rolls the year over', () => {
    expect(priorCalendarMonth('2026-03')).toBe('2026-02');
    expect(priorCalendarMonth('2026-01')).toBe('2025-12');
    expect(priorCalendarMonth('2026-10')).toBe('2026-09');
  });
});

describe('buildCogsRollForward', () => {
  it('foots on every line and on the total', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, month: '2026-03' });
    for (const line of [...rf.lines, rf.total]) {
      expect(line.beginning).not.toBeNull();
      expect(line.adjustment).not.toBeNull();
      const beginning = line.beginning ?? 0;
      const adjustment = line.adjustment ?? 0;
      // beginning + purchases − (cogs + adjustment) = ending, exactly.
      expect(beginning + line.purchases - (line.cogs + adjustment)).toBeCloseTo(line.ending, 2);
      // …and the two halves of what moved out are the close's plug.
      expect(line.cogs + adjustment).toBeCloseTo(line.plug ?? 0, 2);
    }
  });

  it('aggregates every location when the scope is all', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, month: '2026-03' });
    expect(rf.priorMonth).toBe('2026-02');
    const rx = rf.lines.find((l) => l.qbCategory === 'Commercial Rx');
    expect(rx).toBeDefined();
    expect(rx?.beginning).toBe(1_250); // FL 1,200 + TN 50
    expect(rx?.purchases).toBe(1_300); // FL 400 + TX 900
    expect(rx?.ending).toBe(1_830); // FL 1,100 + TN 30 + TX 700
    expect(rx?.cogs).toBe(700); // FL 480 + TN 20 + TX 200
    expect(rf.total.cogs).toBe(700);
    expect(rf.total.ending).toBe(1_830);
  });

  it('scopes to one location', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: FL, month: '2026-03' });
    expect(rf.total.ending).toBe(1_100);
    expect(rf.total.cogs).toBe(480);
    expect(rf.total.beginning).toBe(1_400); // Commercial Rx 1,200 + Compound Ingredient 200
  });

  it('keeps a category that emptied out during the month', () => {
    // Compound Ingredient has no March row at all: the value still left, and
    // dropping the line would hide $200 of movement.
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: FL, month: '2026-03' });
    const gone = rf.lines.find((l) => l.qbCategory === 'Compound Ingredient');
    expect(gone).toBeDefined();
    expect(gone?.beginning).toBe(200);
    expect(gone?.ending).toBe(0);
    expect(gone?.cogs).toBe(0);
    // Ledger consumption reads $0, so the whole movement lands in the residual.
    expect(gone?.adjustment).toBe(200);
  });

  it('sorts by ending value, largest first', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: FL, month: '2026-03' });
    expect(rf.lines.map((l) => l.qbCategory)).toEqual(['Commercial Rx', 'Compound Ingredient']);
  });

  it('has no beginning at a location that has just started trading', () => {
    // Texas's first trading month: there is no prior Texas ledger month, so the
    // beginning is unknown rather than zero and nothing is plugged against it.
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: TX, month: '2026-03' });
    expect(rf.priorMonth).toBeNull();
    expect(rf.total.beginning).toBeNull();
    expect(rf.total.plug).toBeNull();
    expect(rf.total.adjustment).toBeNull();
    expect(rf.lines[0].beginning).toBeNull();
    // The ledger's own consumption is still known and still shown.
    expect(rf.total.cogs).toBe(200);
    expect(rf.delta).toBeNull();
  });

  it('reports the month-over-month delta in dollars and percent', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, month: '2026-03' });
    expect(rf.flag).toBeNull();
    expect(rf.priorFlag).toBeNull();
    expect(rf.total.priorCogs).toBe(640); // FL 550 + 90, TN 0
    expect(rf.delta).toEqual({ dollars: 60, percent: 9.4 });
  });

  it('suppresses the delta when the comparison month is the cutover', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, month: '2026-02' });
    expect(rf.priorMonth).toBe('2026-01');
    expect(rf.priorFlag).toBe('cutover');
    expect(rf.delta).toBeNull();
    // The figures themselves are still there — only the comparison is withheld.
    expect(rf.total.cogs).toBe(640);
    expect(rf.total.priorCogs).toBe(300);
  });

  it('suppresses the delta when the selected month is a true-up', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: FL, month: '2026-09' });
    expect(rf.flag).toBe('true-up');
    expect(rf.priorFlag).toBeNull();
    expect(rf.delta).toBeNull();
    expect(rf.total.cogs).toBe(-120);
  });

  it('withholds the percent when the prior month consumed nothing', () => {
    const rf = buildCogsRollForward(MOVEMENT, { ...ALL, location: TN, month: '2026-03' });
    expect(rf.total.priorCogs).toBe(0);
    expect(rf.delta).toEqual({ dollars: 20, percent: null });
  });

  it('reads an empty series as an empty month rather than throwing', () => {
    const rf = buildCogsRollForward([], { ...ALL, month: '2026-03' });
    expect(rf.lines).toEqual([]);
    expect(rf.priorMonth).toBeNull();
    expect(rf.total.cogs).toBe(0);
    expect(rf.total.beginning).toBeNull();
  });
});

describe('movementToCogsRows', () => {
  it('projects consumption onto the series cogs-view decides the flags from', () => {
    const rows = movementToCogsRows(MOVEMENT);
    expect(rows).toHaveLength(MOVEMENT.length);
    expect(rows[0]).toEqual({
      month: '2026-01',
      location: FL,
      qbCategory: 'Commercial Rx',
      cogs: 300,
    });
  });
});

describe('movementLocations', () => {
  it('lists only the locations that traded in the months on screen', () => {
    expect(movementLocations(MOVEMENT, ['2026-03', '2026-02'])).toEqual([FL, TN, TX]);
    expect(movementLocations(MOVEMENT, ['2026-09', null])).toEqual([FL]);
  });
});
