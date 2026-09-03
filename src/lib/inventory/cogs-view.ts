import type { CategoryCogsSeriesRow } from '@/types/inventory';

/**
 * The month/category grid every COGS surface is drawn from, and — the reason
 * this is a module and not inline in a component — the ONE place that decides
 * which months are operating cost of goods and which are not.
 *
 * TWO MONTHS ARE NOT OPERATING COGS. Both are labelled rather than dropped:
 *
 *  - the FIRST ANCHORED month carries the catch-up write-off from every
 *    unanchored month before it ($2,170,590 combined at 2026-01 against ~$290k
 *    in a normal month). A $2.2M January read as cost of goods would be a
 *    serious misreading, so it is shown, flagged `cutover`, and excluded from
 *    every total.
 *  - a NEGATIVE month is the current-month lot anchor truing value back UP
 *    (2026-09: FL −53,918, TN −47,196, TX −58,115), not a credit to cost of
 *    goods. Flagged `true-up`, same treatment.
 *
 * Neither is hardcoded to a date: the first is `min(as_of_month)` where the
 * ledger is anchored, handed down from the API; the second is simply the sign.
 */
export type CogsMonthFlag = 'cutover' | 'true-up' | null;

export interface CogsGrid {
  /** Ascending, and the column order of every table built from this grid. */
  months: string[];
  categories: string[];
  /** `${month}|${category}` -> dollars. Absent means no movement, not zero. */
  cells: ReadonlyMap<string, number>;
  /** Every category summed, per month — the number the flags are decided on. */
  monthTotals: ReadonlyMap<string, number>;
  flags: ReadonlyMap<string, CogsMonthFlag>;
}

export interface CogsGridScope {
  /** An inventory location, or 'all' to aggregate across every location. */
  location: string;
  /** From `/api/inventory/cogs`; null when the ledger is not anchored anywhere. */
  firstAnchoredMonth: string | null;
  /** Inclusive 'YYYY-MM' window. Omitted means the whole history. */
  fromMonth?: string;
  toMonth?: string;
}

/** Dollars in, dollars out, summed in integer cents so two groupings of the
 *  same cells cannot land a cent apart — the same rule the valuation page's
 *  `view` memo follows, and for the same reason. */
function sumDollars(values: Iterable<number>): number {
  let cents = 0;
  for (const v of values) cents += Math.round(v * 100);
  return cents / 100;
}

export function buildCogsGrid(
  rows: readonly CategoryCogsSeriesRow[],
  { location, firstAnchoredMonth, fromMonth, toMonth }: CogsGridScope,
): CogsGrid {
  const scoped = rows.filter(
    (r) =>
      (location === 'all' || r.location === location) &&
      (fromMonth === undefined || r.month >= fromMonth) &&
      (toMonth === undefined || r.month <= toMonth),
  );

  // Cent-grain accumulation: 'all' sums three locations into one cell, so the
  // aggregate has to round once per cell rather than once per location.
  const cellCents = new Map<string, number>();
  for (const r of scoped) {
    const key = `${r.month}|${r.qbCategory}`;
    cellCents.set(key, (cellCents.get(key) ?? 0) + Math.round(r.cogs * 100));
  }
  const cells = new Map<string, number>([...cellCents].map(([k, c]) => [k, c / 100]));

  const months = [...new Set(scoped.map((r) => r.month))].sort();
  const categories = [...new Set(scoped.map((r) => r.qbCategory))].sort();

  const monthTotals = new Map<string, number>();
  const flags = new Map<string, CogsMonthFlag>();
  for (const m of months) {
    const total = sumDollars(categories.map((c) => cells.get(`${m}|${c}`) ?? 0));
    monthTotals.set(m, total);
    // Cutover wins: the first anchored month can also be negative at some
    // location, and it is the catch-up discharge that explains it.
    flags.set(m, m === firstAnchoredMonth ? 'cutover' : total < 0 ? 'true-up' : null);
  }

  return { months, categories, cells, monthTotals, flags };
}

export function cogsCell(grid: CogsGrid, month: string, qbCategory: string): number {
  return grid.cells.get(`${month}|${qbCategory}`) ?? 0;
}

export function monthTotal(grid: CogsGrid, month: string): number {
  return grid.monthTotals.get(month) ?? 0;
}

export function monthFlag(grid: CogsGrid, month: string): CogsMonthFlag {
  return grid.flags.get(month) ?? null;
}

/** True for the months held out of every operating total — cutover and true-up. */
export function isExcludedMonth(grid: CogsGrid, month: string): boolean {
  return monthFlag(grid, month) !== null;
}

/** The months that ARE operating cost of goods, in column order. */
export function operatingMonths(grid: CogsGrid): string[] {
  return grid.months.filter((m) => !isExcludedMonth(grid, m));
}

/** One category's operating COGS across the window — the row total. */
export function categoryOperatingTotal(grid: CogsGrid, qbCategory: string): number {
  return sumDollars(operatingMonths(grid).map((m) => cogsCell(grid, m, qbCategory)));
}

/** The window's operating COGS — the figure that ties to the 5000.xx P&L. */
export function operatingTotal(grid: CogsGrid): number {
  return sumDollars(operatingMonths(grid).map((m) => monthTotal(grid, m)));
}

const MONTH_NAMES = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * 'YYYY-MM' -> 'Mar', or 'Mar ’26' once the window spans more than one year —
 * twelve bare month names covering two years is a column header that lies.
 */
export function monthLabel(month: string, withYear = false): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7))];
  if (!name) return month;
  return withYear ? `${name} ’${month.slice(2, 4)}` : name;
}

/** True when the months span more than one calendar year. */
export function spansYears(months: readonly string[]): boolean {
  return new Set(months.map((m) => m.slice(0, 4))).size > 1;
}
