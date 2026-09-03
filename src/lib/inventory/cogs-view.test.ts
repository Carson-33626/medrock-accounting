import { describe, it, expect } from 'vitest';
import {
  buildCogsGrid,
  categoryOperatingTotal,
  cogsCell,
  isExcludedMonth,
  monthFlag,
  monthLabel,
  monthTotal,
  operatingMonths,
  operatingTotal,
  spansYears,
} from './cogs-view';
import type { CategoryCogsSeriesRow } from '@/types/inventory';

/** A miniature of the real shape: a cutover January, two normal months, and a
 *  negative current month, across two locations. */
const ROWS: CategoryCogsSeriesRow[] = [
  { month: '2026-01', location: 'MedRock Florida', qbCategory: 'Commercial Rx', cogs: 900_000 },
  { month: '2026-01', location: 'MedRock Florida', qbCategory: 'Compound Ingredient', cogs: 300_000 },
  { month: '2026-01', location: 'MedRock Texas', qbCategory: 'Commercial Rx', cogs: 500_000 },
  { month: '2026-02', location: 'MedRock Florida', qbCategory: 'Commercial Rx', cogs: 100_000 },
  { month: '2026-02', location: 'MedRock Florida', qbCategory: 'Compound Ingredient', cogs: 50_000 },
  { month: '2026-02', location: 'MedRock Texas', qbCategory: 'Commercial Rx', cogs: 80_000 },
  { month: '2026-03', location: 'MedRock Florida', qbCategory: 'Commercial Rx', cogs: 120_000 },
  { month: '2026-03', location: 'MedRock Texas', qbCategory: 'Commercial Rx', cogs: 90_000 },
  { month: '2026-09', location: 'MedRock Florida', qbCategory: 'Commercial Rx', cogs: -53_918 },
  { month: '2026-09', location: 'MedRock Texas', qbCategory: 'Commercial Rx', cogs: -58_115 },
];

const FL = { location: 'MedRock Florida', firstAnchoredMonth: '2026-01' };
const ALL = { location: 'all', firstAnchoredMonth: '2026-01' };

describe('buildCogsGrid', () => {
  it('scopes to one location and lays months out in order', () => {
    const grid = buildCogsGrid(ROWS, FL);
    expect(grid.months).toEqual(['2026-01', '2026-02', '2026-03', '2026-09']);
    expect(grid.categories).toEqual(['Commercial Rx', 'Compound Ingredient']);
    expect(cogsCell(grid, '2026-02', 'Commercial Rx')).toBe(100_000);
    // Texas is out of scope, so its Commercial Rx never lands in a Florida cell.
    expect(monthTotal(grid, '2026-02')).toBe(150_000);
  });

  it("aggregates every location when the scope is 'all'", () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(cogsCell(grid, '2026-02', 'Commercial Rx')).toBe(180_000);
    expect(monthTotal(grid, '2026-02')).toBe(230_000);
    expect(monthTotal(grid, '2026-09')).toBe(-112_033);
  });

  it('reads an absent cell as zero rather than undefined', () => {
    const grid = buildCogsGrid(ROWS, FL);
    expect(cogsCell(grid, '2026-03', 'Compound Ingredient')).toBe(0);
    expect(cogsCell(grid, '2025-12', 'Commercial Rx')).toBe(0);
  });

  it('honours an inclusive month window', () => {
    const grid = buildCogsGrid(ROWS, { ...ALL, fromMonth: '2026-02', toMonth: '2026-03' });
    expect(grid.months).toEqual(['2026-02', '2026-03']);
    expect(monthTotal(grid, '2026-02')).toBe(230_000);
  });

  it('sums in cents, so an aggregate cell cannot drift off its parts', () => {
    const pennies: CategoryCogsSeriesRow[] = [
      { month: '2026-04', location: 'MedRock Florida', qbCategory: 'Uncoded', cogs: 0.105 },
      { month: '2026-04', location: 'MedRock Texas', qbCategory: 'Uncoded', cogs: 0.105 },
      { month: '2026-04', location: 'MedRock Tennessee', qbCategory: 'Uncoded', cogs: 0.105 },
    ];
    const grid = buildCogsGrid(pennies, { location: 'all', firstAnchoredMonth: null });
    expect(cogsCell(grid, '2026-04', 'Uncoded')).toBe(0.33);
    expect(monthTotal(grid, '2026-04')).toBe(0.33);
  });

  it('builds an empty grid without throwing when nothing is in scope', () => {
    const grid = buildCogsGrid(ROWS, { location: 'MedRock Nowhere', firstAnchoredMonth: null });
    expect(grid.months).toEqual([]);
    expect(grid.categories).toEqual([]);
    expect(operatingTotal(grid)).toBe(0);
  });

  it('discovers categories from the data instead of a fixed list', () => {
    const grid = buildCogsGrid(
      [{ month: '2026-05', location: 'MedRock Texas', qbCategory: 'Some Future Category', cogs: 10 }],
      { location: 'all', firstAnchoredMonth: null },
    );
    expect(grid.categories).toEqual(['Some Future Category']);
  });
});

describe('flagging the two months that are not operating COGS', () => {
  it('flags the first anchored month as the cutover discharge', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(monthFlag(grid, '2026-01')).toBe('cutover');
    expect(isExcludedMonth(grid, '2026-01')).toBe(true);
  });

  it('flags a negative month as the anchor truing value back up', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(monthFlag(grid, '2026-09')).toBe('true-up');
    expect(isExcludedMonth(grid, '2026-09')).toBe(true);
  });

  it('leaves a normal month unflagged', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(monthFlag(grid, '2026-02')).toBeNull();
    expect(isExcludedMonth(grid, '2026-02')).toBe(false);
  });

  it('calls a negative first-anchored month cutover, not true-up', () => {
    const grid = buildCogsGrid(
      [{ month: '2026-01', location: 'MedRock Texas', qbCategory: 'Commercial Rx', cogs: -5_000 }],
      { location: 'all', firstAnchoredMonth: '2026-01' },
    );
    expect(monthFlag(grid, '2026-01')).toBe('cutover');
  });

  it('flags nothing as cutover when the ledger is anchored nowhere', () => {
    const grid = buildCogsGrid(ROWS, { location: 'all', firstAnchoredMonth: null });
    expect(monthFlag(grid, '2026-01')).toBeNull();
    expect(monthFlag(grid, '2026-09')).toBe('true-up');
  });

  it('drops the cutover flag when the window opens after that month', () => {
    const grid = buildCogsGrid(ROWS, { ...ALL, fromMonth: '2026-02' });
    expect(grid.months).not.toContain('2026-01');
    expect(operatingMonths(grid)).toEqual(['2026-02', '2026-03']);
  });
});

describe('operating totals', () => {
  it('excludes both flagged months from the window total', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(operatingMonths(grid)).toEqual(['2026-02', '2026-03']);
    // 230,000 + 210,000 — the $1.7M cutover and the −112,033 true-up stay out.
    expect(operatingTotal(grid)).toBe(440_000);
  });

  it('excludes them from a category row total too', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    expect(categoryOperatingTotal(grid, 'Commercial Rx')).toBe(390_000);
    expect(categoryOperatingTotal(grid, 'Compound Ingredient')).toBe(50_000);
  });

  it('foots: the category row totals sum to the operating total', () => {
    const grid = buildCogsGrid(ROWS, ALL);
    const footed = grid.categories.reduce((s, c) => s + categoryOperatingTotal(grid, c), 0);
    expect(footed).toBeCloseTo(operatingTotal(grid), 2);
  });

  it('is zero when every month in the window is flagged', () => {
    const grid = buildCogsGrid(ROWS, { ...ALL, toMonth: '2026-01' });
    expect(operatingMonths(grid)).toEqual([]);
    expect(operatingTotal(grid)).toBe(0);
  });
});

describe('month labels', () => {
  it('is the bare month name inside one year', () => {
    expect(monthLabel('2026-03')).toBe('Mar');
    expect(monthLabel('2026-12')).toBe('Dec');
  });

  it('carries the year once asked to', () => {
    expect(monthLabel('2026-03', true)).toBe('Mar ’26');
  });

  it('falls back to the raw string it cannot parse', () => {
    expect(monthLabel('nonsense')).toBe('nonsense');
  });

  it('detects a window that crosses a year boundary', () => {
    expect(spansYears(['2026-01', '2026-09'])).toBe(false);
    expect(spansYears(['2025-11', '2026-01'])).toBe(true);
    expect(spansYears([])).toBe(false);
  });
});
