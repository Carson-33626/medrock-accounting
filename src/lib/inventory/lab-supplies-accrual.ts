/**
 * Lab-supplies accrual — the simulated monthly cost for stock FIFO cannot see.
 *
 * WHY THIS EXISTS
 *
 * Lab supplies (gloves, gowns, masks, shoe covers, bleach) are bought ad hoc and
 * almost never received into LifeFile, so the FIFO ledger has no basis to deplete.
 * Measured 2026-09-03 against QuickBooks bill lines coded to 1220.20 and 5000.25:
 * real spend runs ~$7,450/month across the three entities against $674.55 that
 * reached LifeFile in all of 2026 — under 1.5%. Carson's ruling: clear the category
 * out of FIFO entirely and ACCRUE the cost instead.
 *
 * WHY NOT A FLAT MONTHLY FIGURE
 *
 * QuickBooks entry lags the purchase, so a flat rate is wrong in both directions:
 * it under-states a recent month nobody has keyed yet, then double-counts once
 * those bills finally land. Carson: "query QB, check for bills matching the tag,
 * then measure the time between and adjust accordingly."
 *
 * WHY NOT A CADENCE MODEL EITHER — MEASURED AND RULED OUT
 *
 * Time between bills carries no signal. Inter-arrival gaps have CV 1.64 (FL), 1.26
 * (TN), 2.69 (TX) — at or above 1, i.e. bursty/random rather than rhythmic — and
 * the mean gap is only 1.7-2.8 days because these are a near-daily dribble of
 * Amazon orders, not periodic invoices. "Days since the last bill" is therefore
 * always ~0 and predicts nothing; amount-versus-preceding-gap correlation is
 * 0.07-0.18. The predictive lever is not WHEN bills arrive but HOW MUCH of a month
 * has arrived yet.
 *
 * THE FORMULA
 *
 *   accrual(M)        = (1 - completeness) x trailingAverage
 *   estimatedTotal(M) = observedToDate(M) + accrual(M)
 *
 * That is a credibility-weighted blend, not an ad-hoc fudge: weighting the
 * scale-up estimator `observed / c` by `c`, and the historical prior by `1 - c`,
 * gives `c * (observed / c) + (1 - c) * avg` = `observed + (1 - c) * avg`. It
 * defaults cleanly to history when nothing is keyed yet (where the literal ratio
 * would divide by ~0, or return $0 from $0 observed — exactly backwards), and the
 * accrual shrinks to nothing as the month settles, so it reverses itself instead
 * of standing as a permanent plug.
 *
 * COMPLETENESS IS THE LOWER OF TWO MEASURES
 *
 * 1. The CURVE — what fraction of a month is typically visible D days after
 *    month-end, fitted on months old enough to have settled.
 * 2. The ENTRY CLAMP — documents actually keyed for that month over the location's
 *    normal monthly document count.
 *
 * The clamp exists because the curve encodes NORMAL entry behaviour and behaviour
 * is not always normal. Verified 2026-09-03: median entry lag for April and May
 * 2026 purchases spiked to 124 and 132 days against 1-2 days through 2025, and the
 * backfill is still running — 18 of those documents were keyed on 2026-09-02 and
 * -03. The accountant is working through it chronologically and has not reached
 * June. On elapsed days alone the curve calls June ~90% settled and returns a $340
 * accrual for Tennessee; on documents, June holds 3 of a normal 15, so it is 20%
 * settled and the accrual is $1,975. The clamp is what makes the formula honest
 * while a backlog drains, and it relaxes on its own as entry catches up.
 *
 * Sources: docs/fifo-monthly-close/lab-supplies-accrual-formula-2026-09-03.md and
 * lab-supplies-purchasing-research-2026-09-03.md (1,890 bill lines / 1,235
 * documents, each traceable to a QuickBooks document id).
 */

/** The three entities this runs for, in QuickBooks token naming. */
export type AccrualLocation = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';

/**
 * Fraction of a month's eventual total typically visible D days after month-end,
 * from months old enough to be settled (month-end + 300 days, comfortably past
 * FL's 279-day longest observed lag).
 *
 * TX has ZERO settled months — its whole history starts 2026-01 — so it borrows
 * the pooled FL+TN curve. Its first eligible month arrives around November 2026
 * and a useful count of them not until mid-2027. A stated limitation, not an
 * oversight: `curveIsBorrowed` reports it so the UI can say so.
 */
const COMPLETENESS_CURVE: Readonly<Record<AccrualLocation, ReadonlyArray<readonly [number, number]>>> = {
  'MedRock FL': [
    [7, 0.512], [14, 0.549], [21, 0.585], [30, 0.625], [45, 0.674], [60, 0.710],
    [90, 0.770], [120, 0.828], [150, 0.875], [180, 0.904], [210, 0.938],
    [240, 0.968], [270, 0.997], [300, 1],
  ],
  'MedRock TN': [
    [7, 0.835], [14, 0.890], [21, 0.903], [30, 0.948], [45, 0.955], [60, 1],
    [90, 1], [120, 1], [150, 1], [180, 1], [210, 1], [240, 1], [270, 1], [300, 1],
  ],
  // Pooled FL+TN, borrowed by TX.
  'MedRock TX': [
    [7, 0.639], [14, 0.683], [21, 0.710], [30, 0.752], [45, 0.784], [60, 0.824],
    [90, 0.860], [120, 0.896], [150, 0.924], [180, 0.942], [210, 0.963],
    [240, 0.981], [270, 0.998], [300, 1],
  ],
};

/** True where the curve is not that location's own — TX borrows the pooled one. */
export function curveIsBorrowed(location: AccrualLocation): boolean {
  return location === 'MedRock TX';
}

/**
 * The historical monthly rate the accrual falls back to.
 *
 * FL and TN are a trailing-12 average computed to 2026-04 — deliberately stopping
 * before the entry disruption rather than through today, so the backlog cannot
 * drag the baseline down. TX has only five clean months and gets their mean; it is
 * the weakest number here and should be re-fitted once TX has a full year.
 */
const TRAILING_AVERAGE: Readonly<Record<AccrualLocation, number>> = {
  'MedRock FL': 3024.06,
  'MedRock TN': 2469.20,
  'MedRock TX': 2069.69,
};

/**
 * Median lab-supply documents per month, over 2025-01..2026-03 — before the entry
 * disruption. The clamp's denominator.
 *
 * TX's is three months of history against FL and TN's fifteen. Treat it as
 * indicative.
 */
const NORMAL_DOCS_PER_MONTH: Readonly<Record<AccrualLocation, number>> = {
  'MedRock FL': 26,
  'MedRock TN': 15,
  'MedRock TX': 26,
};

/** A month whose estimate lands under this share of history gets flagged. */
const LOW_ESTIMATE_FLAG = 0.5;

export interface AccrualInput {
  location: AccrualLocation;
  /** Last day of the accrual month, 'YYYY-MM-DD'. */
  monthEnd: string;
  /** The day the accrual is being computed, 'YYYY-MM-DD'. */
  asOf: string;
  /** Lab-supply dollars already entered in QuickBooks for that month. */
  observedToDate: number;
  /** Distinct QuickBooks documents already entered for that month. */
  observedDocs: number;
}

export interface AccrualResult {
  daysElapsed: number;
  /** Completeness from the curve alone — what elapsed time suggests. */
  curveCompleteness: number;
  /** Completeness from documents keyed — what entry activity shows. */
  entryCompleteness: number;
  /** The lower of the two: the one actually used. */
  completeness: number;
  /** Which measure bound the result — useful for explaining a number on screen. */
  boundBy: 'curve' | 'entry';
  trailingAverage: number;
  /** The journal entry: Dr 5000.25 Lab Supplies / Cr 1220.20 Lab Supplies Inventory. */
  accrual: number;
  /** observedToDate + accrual — what the month is expected to have cost. */
  estimatedTotal: number;
  /** True when the estimate is implausibly low against history — review, do not post. */
  flagged: boolean;
  flagReason: string | null;
  /** True when this location is using another's curve (TX). */
  borrowedCurve: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole days between two ISO dates, never negative. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Completeness at an exact day count, linearly interpolated between the table's
 * points. Before the first point it scales from zero — a month that ended
 * yesterday is not 51% complete just because the curve starts at day 7.
 */
export function completenessAt(location: AccrualLocation, daysElapsed: number): number {
  const curve = COMPLETENESS_CURVE[location];
  if (daysElapsed <= 0) return 0;
  const first = curve[0];
  if (daysElapsed < first[0]) return (daysElapsed / first[0]) * first[1];
  for (let i = 0; i < curve.length - 1; i += 1) {
    const [d0, c0] = curve[i];
    const [d1, c1] = curve[i + 1];
    if (daysElapsed <= d1) {
      return c0 + ((daysElapsed - d0) / (d1 - d0)) * (c1 - c0);
    }
  }
  return 1;
}

/**
 * The whole calculation for one location-month.
 *
 * Deliberately pure and I/O-free: the QuickBooks read that supplies
 * `observedToDate` and `observedDocs` lives at the edge, so the arithmetic that
 * decides a posted number can be tested without a network.
 */
export function computeAccrual(input: AccrualInput): AccrualResult {
  const { location, monthEnd, asOf, observedToDate, observedDocs } = input;
  const daysElapsed = daysBetween(monthEnd, asOf);

  const curveCompleteness = completenessAt(location, daysElapsed);
  const normalDocs = NORMAL_DOCS_PER_MONTH[location];
  const entryCompleteness = Math.min(1, Math.max(0, observedDocs / normalDocs));

  const completeness = Math.min(curveCompleteness, entryCompleteness);
  const trailingAverage = TRAILING_AVERAGE[location];

  const accrual = round2(Math.max(0, (1 - completeness) * trailingAverage));
  const estimatedTotal = round2(observedToDate + accrual);

  const flagged = estimatedTotal < LOW_ESTIMATE_FLAG * trailingAverage;
  return {
    daysElapsed,
    curveCompleteness,
    entryCompleteness,
    completeness,
    boundBy: entryCompleteness < curveCompleteness ? 'entry' : 'curve',
    trailingAverage,
    accrual,
    estimatedTotal,
    flagged,
    flagReason: flagged
      ? `Estimated $${estimatedTotal.toFixed(2)} is under half the ${trailingAverage.toFixed(2)} ` +
        'monthly average — review before posting.'
      : null,
    borrowedCurve: curveIsBorrowed(location),
  };
}

/** Read-only view of the parameters, so the UI can show what drove a number. */
export const ACCRUAL_PARAMETERS = {
  trailingAverage: TRAILING_AVERAGE,
  normalDocsPerMonth: NORMAL_DOCS_PER_MONTH,
  lowEstimateFlag: LOW_ESTIMATE_FLAG,
} as const;
