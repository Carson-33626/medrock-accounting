import type { CategoryCogsSeriesRow, CategoryLedgerMovementRow } from '@/types/inventory';
import { buildCogsGrid, monthFlag, type CogsMonthFlag } from './cogs-view';

/**
 * The COGS tab's two-month roll-forward: where the month started, what came in,
 * what went out, where it ended — plus the month before it as the comparison.
 *
 * WHY TWO MONTHS. The tab used to be a category x month grid running January to
 * the selected month, which is the shape a P&L is read in and NOT the shape this
 * page is used in (Carson, 2026-09-03: "when i select march, shouldn't the COGS
 * breakdown show Feb & March to show where we started, and the COGS used during
 * the month... in reality this page will only ever need to look at two"). A
 * nine-column grid answers "how has the year gone"; the question actually being
 * asked at the close is "is this month normal, and does it foot".
 *
 * THE ARITHMETIC IS THE CLOSE'S, deliberately. `buildCategoryRollForward` in
 * `monthly-close.ts` computes this same shape for the journal entry, and the two
 * must not be able to disagree. Same convention here:
 *
 *   beginning + purchases − (cogs + adjustment) = ending
 *
 * where `cogs + adjustment` is the close's PLUG (`beginning + purchases − ending`)
 * and `cogs` alone is the ledger's own `qty_consumed x unit_cost`. The close carries
 * both for comparison; this tab SPLITS them, because on a COGS tab the difference
 * has a name and a different account:
 *
 *  - `cogs` is what posts to the 5000.xx cost-of-goods accounts.
 *  - `adjustment` is everything else that moved value: the anchor writing stock
 *    down to a real count (shrink, which posts to 5000.55 and is emphatically not
 *    cost of goods), the current-month anchor writing value back UP, and
 *    opening-balance lots whose remaining value declines while the unit-cost term
 *    reads $0 because an OB lot has no unit cost (Florida: $220.38, $125.78,
 *    $176.25 in 2026-03, -06, -07 — the one cell of thirteen where the plug and
 *    the ledger figure differ at all).
 *
 * Taking the difference as a residual rather than a second derivation is what
 * makes the row foot by construction, which is the entire point of showing a
 * roll-forward.
 */

/** One (location, category) roll-forward line for the selected month. */
export interface CogsRollForwardLine {
  qbCategory: string;
  /**
   * The prior month's ending value. Null when there is no prior month in the
   * ledger for this scope at all — the earliest month, and Texas's first trading
   * month. Zero, by contrast, means the category is genuinely new this month.
   */
  beginning: number | null;
  purchases: number;
  /** Ledger consumption — the figure that posts to 5000.xx. */
  cogs: number;
  /**
   * The plug's residual: shrink/anchor movement plus opening-balance lots that
   * carry no unit cost. Null with no beginning, where there is nothing to plug
   * against and an invented figure would be worse than a blank.
   */
  adjustment: number | null;
  /** `beginning + purchases − ending` — the close's COGS figure, kept whole so the
   *  two surfaces can be tied to each other without re-deriving it. */
  plug: number | null;
  ending: number;
  /** The same category's ledger consumption in the prior month. */
  priorCogs: number;
}

/** Dollars and percent against the prior month, or null when the comparison is
 *  meaningless — see `buildCogsRollForward`. */
export interface CogsMonthDelta {
  dollars: number;
  /** Null when the prior month is $0: a percentage against zero says nothing. */
  percent: number | null;
}

export interface CogsRollForward {
  month: string;
  /** The calendar predecessor, when the ledger has it for this scope. */
  priorMonth: string | null;
  /** Sorted by ending value descending — the close's order. */
  lines: CogsRollForwardLine[];
  /** Every line summed. `qbCategory` is the label the caller prints. */
  total: CogsRollForwardLine;
  flag: CogsMonthFlag;
  priorFlag: CogsMonthFlag;
  /**
   * Null when there is no prior month, or when EITHER month is flagged. A cutover
   * month is a $2.2M one-time discharge and a true-up month is negative; a
   * percentage against either is a number that reads like information and is not.
   */
  delta: CogsMonthDelta | null;
}

export interface CogsRollForwardScope {
  /** An inventory location, or 'all' to aggregate every location. */
  location: string;
  /** From `/api/inventory/cogs`; null when the ledger is not anchored anywhere. */
  firstAnchoredMonth: string | null;
  month: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Summed in integer cents so the total row and the lines above it cannot land a
 *  cent apart — the same rule `cogs-view` follows, and for the same reason. */
function sumDollars(values: Iterable<number>): number {
  let cents = 0;
  for (const v of values) cents += Math.round(v * 100);
  return cents / 100;
}

/** 'YYYY-MM' → the month before it. */
export function priorCalendarMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month;
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * The movement series as the COGS rows `cogs-view` decides the flags from.
 *
 * The flags stay that module's decision and no other's — this is only the
 * projection that lets it see a series it already understands. `consumedValue` IS
 * the COGS series: the two came from one query as of 2026-09-03, so they are the
 * same number rather than two numbers that ought to agree.
 */
export function movementToCogsRows(
  movement: readonly CategoryLedgerMovementRow[],
): CategoryCogsSeriesRow[] {
  return movement.map((r) => ({
    month: r.month,
    location: r.location,
    qbCategory: r.qbCategory,
    cogs: r.consumedValue,
  }));
}

/** Cells for one month, aggregated across the locations in scope. */
interface MonthCells {
  ending: Map<string, number>;
  purchases: Map<string, number>;
  consumed: Map<string, number>;
  present: boolean;
}

function cellsForMonth(
  movement: readonly CategoryLedgerMovementRow[],
  location: string,
  month: string,
): MonthCells {
  const ending = new Map<string, number>();
  const purchases = new Map<string, number>();
  const consumed = new Map<string, number>();
  let present = false;

  for (const r of movement) {
    if (r.month !== month) continue;
    if (location !== 'all' && r.location !== location) continue;
    present = true;
    // Cent-grain accumulation: 'all' folds three locations into one cell, so the
    // aggregate has to round once per cell rather than once per location.
    const add = (m: Map<string, number>, v: number): void => {
      m.set(r.qbCategory, (m.get(r.qbCategory) ?? 0) + Math.round(v * 100));
    };
    add(ending, r.endingValue);
    add(purchases, r.purchasesValue);
    add(consumed, r.consumedValue);
  }

  const toDollars = (m: Map<string, number>): Map<string, number> =>
    new Map([...m].map(([k, cents]) => [k, cents / 100]));

  return {
    ending: toDollars(ending),
    purchases: toDollars(purchases),
    consumed: toDollars(consumed),
    present,
  };
}

export function buildCogsRollForward(
  movement: readonly CategoryLedgerMovementRow[],
  { location, firstAnchoredMonth, month }: CogsRollForwardScope,
): CogsRollForward {
  const priorCandidate = priorCalendarMonth(month);
  const current = cellsForMonth(movement, location, month);
  const prior = cellsForMonth(movement, location, priorCandidate);
  // Only the CALENDAR predecessor can serve as the beginning balance. Reaching
  // further back for the nearest month that happens to exist would pair an opening
  // from January with purchases from March and bury the gap in `adjustment`.
  const priorMonth = prior.present ? priorCandidate : null;

  // The union of both months, not just the current one: a category can be emptied
  // during the month and vanish from the ledger, and dropping it would hide the
  // value that left. The close's own roll-forward iterates the current month only
  // because its job is to state a closing balance per account, not to explain a
  // movement.
  const categories = [
    ...new Set([...current.ending.keys(), ...current.consumed.keys(), ...prior.ending.keys()]),
  ];

  const lines: CogsRollForwardLine[] = categories
    .map((qbCategory) => {
      const beginning = priorMonth === null ? null : round2(prior.ending.get(qbCategory) ?? 0);
      const purchases = round2(current.purchases.get(qbCategory) ?? 0);
      const ending = round2(current.ending.get(qbCategory) ?? 0);
      const cogs = round2(current.consumed.get(qbCategory) ?? 0);
      const plug = beginning === null ? null : round2(beginning + purchases - ending);
      return {
        qbCategory,
        beginning,
        purchases,
        cogs,
        adjustment: plug === null ? null : round2(plug - cogs),
        plug,
        ending,
        priorCogs: round2(prior.consumed.get(qbCategory) ?? 0),
      };
    })
    .sort((a, b) => b.ending - a.ending || a.qbCategory.localeCompare(b.qbCategory));

  const sumOf = (pick: (l: CogsRollForwardLine) => number): number =>
    sumDollars(lines.map(pick));
  const totalBeginning = priorMonth === null ? null : sumOf((l) => l.beginning ?? 0);
  const totalPurchases = sumOf((l) => l.purchases);
  const totalEnding = sumOf((l) => l.ending);
  const totalCogs = sumOf((l) => l.cogs);
  const totalPlug =
    totalBeginning === null ? null : round2(totalBeginning + totalPurchases - totalEnding);
  const totalPriorCogs = sumOf((l) => l.priorCogs);

  const total: CogsRollForwardLine = {
    qbCategory: 'Total',
    beginning: totalBeginning,
    purchases: totalPurchases,
    cogs: totalCogs,
    adjustment: totalPlug === null ? null : round2(totalPlug - totalCogs),
    plug: totalPlug,
    ending: totalEnding,
    priorCogs: totalPriorCogs,
  };

  // The flags are `cogs-view`'s call and only its call — the whole history is
  // handed over so it sees the same series every other COGS surface does.
  const grid = buildCogsGrid(movementToCogsRows(movement), { location, firstAnchoredMonth });
  const flag = monthFlag(grid, month);
  const priorFlag = priorMonth === null ? null : monthFlag(grid, priorMonth);

  const comparable = priorMonth !== null && flag === null && priorFlag === null;
  const delta: CogsMonthDelta | null = comparable
    ? {
        dollars: round2(totalCogs - totalPriorCogs),
        percent:
          totalPriorCogs === 0
            ? null
            : Math.round(((totalCogs - totalPriorCogs) / Math.abs(totalPriorCogs)) * 1000) / 10,
      }
    : null;

  return { month, priorMonth, lines, total, flag, priorFlag, delta };
}

/**
 * The locations that traded in the given months, in display order — the rows of
 * the by-location cut. Scoped to the months on screen so a location that has since
 * stopped trading does not sit there as a row of dashes.
 */
export function movementLocations(
  movement: readonly CategoryLedgerMovementRow[],
  months: ReadonlyArray<string | null>,
): string[] {
  const wanted = new Set(months.filter((m): m is string => m !== null));
  return [...new Set(movement.filter((r) => wanted.has(r.month)).map((r) => r.location))].sort();
}
