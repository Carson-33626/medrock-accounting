/**
 * Shipping-packaging accrual — the spend on 1220.30 that has not been keyed yet.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A PER-SHIPMENT MODEL
 *
 * The earlier design (`ds-qb-inventory-account-coverage.md` §4) proposed a usage
 * driver: *"every single shipment is 1 mailer"*, consumption = `count(distinct LG
 * Number)`. Its own §8 then flagged the hole — cold-chain shipments need an
 * insulated mailer and gel packs at a very different unit cost, and nothing in the
 * feed says which shipment got one.
 *
 * Carson closed that question on 2026-09-04: *"include the cold chain, for these
 * it's hard to say since not every package gets it, so you'll have to treat it the
 * same way we did lab supplies, check the buy orders and draft the differences."*
 *
 * So the driver is the buy orders, not the shipment count. Measured 2026-09-04,
 * that ruling is well supported: cold chain is 8.3% of Florida's 2026 spend, 11.1%
 * of Tennessee's and 31.3% of Texas's — a share far too large and far too variable
 * across entities to fold into one blended per-shipment rate.
 *
 * THE FORMULA — the lab-supplies shape, refitted on this account
 *
 *   accrual(M)        = (1 - completeness) x trailingAverage
 *   estimatedTotal(M) = observedToDate(M) + accrual(M)
 *
 * Same credibility-weighted blend as `lab-supplies-accrual.ts`: weight the scale-up
 * estimator `observed / c` by `c` and the historical prior by `1 - c`. It defaults
 * to history when nothing is keyed and shrinks to zero as the month settles, so it
 * reverses itself instead of standing as a permanent plug.
 *
 * WHAT IS DIFFERENT FROM LAB SUPPLIES, AND WHY
 *
 * 1. THE CURVE IS THIS ACCOUNT'S OWN, NOT BORROWED. 1220.30 is a handful of large
 *    vendor bills, not a daily dribble of Amazon orders, and it settles far faster:
 *    fitted on 22 settled Florida months and 21 Tennessee months, completeness
 *    reaches 100% by 60 days (lab supplies' Florida curve needs 300). Median entry
 *    lag is 7 days in FL and 4 in TN against lab supplies' 7 and 5, but the p90 is
 *    68/17 days against 121/29. Using the lab-supplies curve here would accrue
 *    months that are demonstrably finished.
 *
 * 2. THE TRAILING AVERAGE IS COMPUTED LIVE, NOT HARDCODED. `lab-supplies-accrual`
 *    freezes three constants that someone has to remember to re-fit. Here the
 *    caller passes the average it just measured from the same QuickBooks pull that
 *    produced `observedToDate`, over a window that ends at the last SETTLED month
 *    (see `trailingAverageWindow`), so a stale constant cannot silently drive a
 *    posted number.
 *
 * 3. THERE IS NO PROPORTIONAL DOCUMENT CLAMP. Lab supplies clamps completeness by
 *    `observedDocs / normalDocsPerMonth` because its denominator is 26 documents a
 *    month — a usable 26-bucket estimator. This account's median is 4 documents in
 *    FL and 5 in TN. A single $7,002 label order would score 25% complete and
 *    accrue 75% of the average on top of a month that is already above average.
 *    Measured and rejected; what survives is the ZERO-ENTRY OVERRIDE below, which
 *    is the one case the curve is definitely wrong about.
 *
 * THE ZERO-ENTRY OVERRIDE
 *
 * A month with literally no documents keyed cannot be called complete, whatever the
 * calendar says. On 2026-09-04 Tennessee's August holds zero 1220.30 documents and
 * Florida's holds one; the curve, reading four elapsed days, would still call August
 * 40-odd percent done off nothing at all. So `observedDocs === 0` forces
 * completeness to 0 and the accrual to a full month's average.
 *
 * WHAT THIS DOES NOT COVER — READ BEFORE ASSUMING IT CLOSES 1220.30
 *
 * The accrual sizes UNBILLED PURCHASES. It says nothing about USAGE. The accountant
 * relieved 1220.30 to COGS every month through 2026-02 and then stopped: the
 * account has run FL 18,934.87 -> 76,402.11, TN 9,537.07 -> 31,933.63 and TX
 * 2,615.59 -> 8,802.44 between 2026-02-28 and 2026-08-31 with not one relieving
 * entry (verified — the roll-forward ties to the cent, `_probe-shipping-purchases.ts`).
 * That ~95k of unrelieved asset is a bigger number than anything here and is the
 * FIFO close's job, not this module's. See the DS, §7.
 *
 * Source: docs/fifo-monthly-close/ds-shipping-packaging-2026-09-04.md.
 */

/** The three entities this runs for, in QuickBooks token naming. */
export type ShippingLocation = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';

export const SHIPPING_LOCATIONS: readonly ShippingLocation[] = [
  'MedRock FL',
  'MedRock TN',
  'MedRock TX',
];

/**
 * Fraction of a month's eventual 1220.30 total typically visible D days after
 * month-end, fitted on months old enough to have settled (month-end + 300 days,
 * past the 130/136-day longest lags observed in FL and TN).
 *
 * Fitted 2026-09-04 by `_probe-shipping-model.ts` over 4,225 extracted bill lines:
 * FL on 22 settled months (2024-01..2025-10), TN on 21 (2024-02..2025-10).
 *
 * TX has ONE settled month and cannot be fitted, so it borrows the FL+TN pooled
 * curve weighted 22:21. Stated, not hidden — `curveIsBorrowed` reports it.
 */
const COMPLETENESS_CURVE: Readonly<
  Record<ShippingLocation, ReadonlyArray<readonly [number, number]>>
> = {
  'MedRock FL': [
    [7, 0.74], [14, 0.824], [21, 0.884], [30, 0.931], [45, 0.994], [60, 1],
    [90, 1], [120, 1], [150, 1], [180, 1], [210, 1], [240, 1], [270, 1], [300, 1],
  ],
  'MedRock TN': [
    [7, 0.811], [14, 0.912], [21, 0.959], [30, 0.959], [45, 1], [60, 1],
    [90, 1], [120, 1], [150, 1], [180, 1], [210, 1], [240, 1], [270, 1], [300, 1],
  ],
  // Pooled FL+TN, borrowed by TX.
  'MedRock TX': [
    [7, 0.775], [14, 0.867], [21, 0.921], [30, 0.945], [45, 0.997], [60, 1],
    [90, 1], [120, 1], [150, 1], [180, 1], [210, 1], [240, 1], [270, 1], [300, 1],
  ],
};

/** True where the curve is not that location's own — TX borrows the pooled one. */
export function curveIsBorrowed(location: ShippingLocation): boolean {
  return location === 'MedRock TX';
}

/**
 * Days after month-end at which this account is treated as settled.
 *
 * 60, because that is where the fitted curve reaches 100% in BOTH entities that
 * have enough history to fit one. It is the boundary of the trailing-average
 * window as well as the point past which the accrual is zero, so the two cannot
 * drift apart.
 */
export const SETTLE_DAYS = 60;

/** Months in the trailing-average window. */
export const TRAILING_MONTHS = 12;

/**
 * Fewer active months than this in the trailing window and the average is not a
 * rate, it is a coincidence. TX carries 5 of 12 on 2026-09-04.
 */
const MIN_ACTIVE_MONTHS = 6;

/** A month whose estimate lands under this share of history gets flagged. */
const LOW_ESTIMATE_FLAG = 0.5;

export interface ShippingAccrualInput {
  location: ShippingLocation;
  /** Last day of the accrual month, 'YYYY-MM-DD'. */
  monthEnd: string;
  /** The day the accrual is being computed, 'YYYY-MM-DD'. */
  asOf: string;
  /** 1220.30 dollars already entered in QuickBooks for that month. */
  observedToDate: number;
  /** Distinct QuickBooks documents already entered for that month. */
  observedDocs: number;
  /** Measured on the same pull — see `trailingAverageWindow`. */
  trailingAverage: number;
  /** Months in that window carrying any 1220.30 activity, out of TRAILING_MONTHS. */
  activeMonths: number;
}

export interface ShippingAccrualResult {
  daysElapsed: number;
  /** Completeness from the curve alone — what elapsed time suggests. */
  curveCompleteness: number;
  /** The one actually used: the curve, or 0 when nothing has been keyed. */
  completeness: number;
  /** True when the zero-entry override, not the curve, decided the answer. */
  zeroEntryOverride: boolean;
  trailingAverage: number;
  /** Dr 5000.20 Final Packaging Materials / Cr 2011 Accrued Expenses. */
  accrual: number;
  /** observedToDate + accrual — what the month is expected to have cost. */
  estimatedTotal: number;
  /** True when the number needs a human before it posts. */
  flagged: boolean;
  flagReason: string | null;
  /** True when this location is using another's curve (TX). */
  borrowedCurve: boolean;
  /** True when the trailing window is too sparse to be a rate (TX). */
  thinHistory: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole days between two ISO dates, never negative. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** Last day of a 'YYYY-MM', as 'YYYY-MM-DD'. */
export function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The 'YYYY-MM' `back` months before `month`. */
export function shiftMonth(month: string, back: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The `TRAILING_MONTHS` months ending at the last month that has SETTLED as of
 * `asOf`, oldest first.
 *
 * Ending at the last settled month rather than at `asOf` is the whole point: the
 * two or three most recent months are exactly the ones still filling in, and
 * letting them into the baseline drags the average down at the moment the accrual
 * leans on it hardest — the same mistake `lab-supplies-purchasing-research` had to
 * correct for by hand when it froze its constants at 2026-04.
 */
export function trailingAverageWindow(asOf: string): string[] {
  let month = asOf.slice(0, 7);
  // Walk back until the month has settled. Bounded by TRAILING_MONTHS steps: a
  // month-end is at most ~31 days ahead of its own month, so 3 steps always
  // suffice at SETTLE_DAYS = 60; the bound is belt-and-braces against a future
  // SETTLE_DAYS that someone raises without revisiting this loop.
  for (let i = 0; i < TRAILING_MONTHS; i += 1) {
    if (daysBetween(monthEndOf(month), asOf) >= SETTLE_DAYS) break;
    month = shiftMonth(month, 1);
  }
  const out: string[] = [];
  for (let i = TRAILING_MONTHS - 1; i >= 0; i -= 1) out.push(shiftMonth(month, i));
  return out;
}

/**
 * Completeness at an exact day count, linearly interpolated between the table's
 * points. Before the first point it scales from zero — a month that ended
 * yesterday is not 74% complete just because the curve starts at day 7.
 */
export function completenessAt(location: ShippingLocation, daysElapsed: number): number {
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
 * Pure and I/O-free, like its lab-supplies counterpart: the QuickBooks read that
 * supplies `observedToDate`, `observedDocs` and `trailingAverage` lives at the
 * edge, so the arithmetic that decides a posted number is testable without a
 * network.
 */
export function computeShippingAccrual(input: ShippingAccrualInput): ShippingAccrualResult {
  const { location, monthEnd, asOf, observedToDate, observedDocs, trailingAverage, activeMonths } =
    input;
  const daysElapsed = daysBetween(monthEnd, asOf);

  const curveCompleteness = completenessAt(location, daysElapsed);
  const zeroEntryOverride = observedDocs === 0;
  const completeness = zeroEntryOverride ? 0 : curveCompleteness;

  const accrual = round2(Math.max(0, (1 - completeness) * Math.max(0, trailingAverage)));
  const estimatedTotal = round2(observedToDate + accrual);

  const thinHistory = activeMonths < MIN_ACTIVE_MONTHS;
  const lowEstimate = trailingAverage > 0 && estimatedTotal < LOW_ESTIMATE_FLAG * trailingAverage;

  const reasons: string[] = [];
  if (lowEstimate) {
    reasons.push(
      `Estimated $${estimatedTotal.toFixed(2)} is under half the $${trailingAverage.toFixed(2)} ` +
        'trailing monthly average — the curve calls the month settled but the dollars say otherwise.',
    );
  }
  if (thinHistory) {
    reasons.push(
      `Only ${activeMonths} of the ${TRAILING_MONTHS} trailing months carry any 1220.30 activity — ` +
        `$${trailingAverage.toFixed(2)} is a thin baseline, not a measured run rate.`,
    );
  }

  return {
    daysElapsed,
    curveCompleteness,
    completeness,
    zeroEntryOverride,
    trailingAverage,
    accrual,
    estimatedTotal,
    flagged: reasons.length > 0,
    flagReason: reasons.length === 0 ? null : reasons.join(' '),
    borrowedCurve: curveIsBorrowed(location),
    thinHistory,
  };
}

/** Read-only view of the parameters, so a screen can show what drove a number. */
export const SHIPPING_ACCRUAL_PARAMETERS = {
  completenessCurve: COMPLETENESS_CURVE,
  settleDays: SETTLE_DAYS,
  trailingMonths: TRAILING_MONTHS,
  minActiveMonths: MIN_ACTIVE_MONTHS,
  lowEstimateFlag: LOW_ESTIMATE_FLAG,
} as const;
