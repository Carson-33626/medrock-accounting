/**
 * Shipping packaging relief — 1220.30 to 5000.20, as a contributor to the monthly close entry.
 *
 * Barbara's method, posted by hand for 2026-03..08 on 2026-09-18 (`{FL,TN,TX} Ship Pkg Adj
 * 26.03`..`26.08`). Carson, same day: *"Barbara did some manual journals for this leg … we need
 * to get this built and deployed. Get it going with inventory journals."* This reproduces her
 * entries to the cent and runs it inside the pooled close from here on.
 *
 *   target(M) = postage(M) × ratio
 *   relief(M) = target(M) − what 5000.20 already carries for M
 *
 * POSTAGE is QuickBooks `5000.40 Postage/Shipping Cost`, accrual P&L, month M — where the
 * EasyPost charges land. Verified against every figure in her memos.
 *
 * THE RATIO IS FROZEN, and stored as numerator/denominator. It is Σ 5000.20 ÷ Σ 5000.40 over
 * 2025-09..2026-02 ("Ratio set from Sep 2025-Feb 2026 actuals"), i.e. calibrated to the
 * accountant's own historical relief. Rounding it to the 4.9192% her memo prints is NOT
 * enough: 78,782.10 × 0.049192 = 3,875.45 but she posted 3,875.43, which only the unrounded
 * quotient reproduces. TX had no postage in the window, so it borrows FL+TN pooled — as she did.
 *
 * "WHAT 5000.20 ALREADY CARRIES" is her "packaging already expensed direct to 5000.20 this
 * month". Reading the month's total makes the line self-correcting: a correction entry after
 * the parent posts sees the parent's relief in that total and books only the difference.
 *
 * A MONTH SHE RELIEVED BY HAND BOOKS NOTHING. Her March entry also carries a Jan–Feb true-up
 * (−694.67 FL), so target − total would re-book it. Any posted manual relief in the month
 * stops the line outright rather than being netted against.
 *
 * Pure. `shipping-relief-server.ts` does the QuickBooks reads.
 * Source: docs/fifo-monthly-close/ds-shipping-relief-2026-09-18.md.
 */
import type { JournalLine } from '@/lib/payroll/types';
import type { JeContribution } from './je-pool';
import type { ShippingLocation } from './shipping-packaging-accrual';

export const SHIPPING_RELIEF_EXPENSE_ACCOUNT = 'Cost of Goods Sold:Final Packaging Materials';
export const SHIPPING_RELIEF_ASSET_ACCOUNT = 'Inventory Asset:Shipping Packaging Material Inventory';

/** Stamped into `sourceRowKeys` so the workbook can split these lines from FIFO's. */
export const SHIPPING_RELIEF_SOURCE_KEY = 'src:shipping-packaging';

/** The ratio's source, kept whole so the division happens at full precision. */
export interface ShippingRatio {
  /** Σ 5000.20 Final Packaging Materials over the window. */
  packaging: number;
  /** Σ 5000.40 Postage/Shipping Cost over the window. */
  postage: number;
  /** Where the figures came from, for the memo and the basis sheet. */
  basis: string;
  /** True when this entity's own history could not set it (TX). */
  borrowed: boolean;
}

const WINDOW = 'Sep 2025–Feb 2026';

/**
 * Read from QuickBooks 2026-09-18 (accrual P&L, `scripts/_probe-postage-qb.ts`). FL Sep–Feb
 * 5000.20: 5,781.37 + 3,753.59 + 3,919.75 + 3,124.92 − 4,131.45 + 10,076.78; TN likewise.
 */
export const SHIPPING_RATIOS: Readonly<Record<ShippingLocation, ShippingRatio>> = {
  'MedRock FL': { packaging: 22_524.96, postage: 457_901.01, basis: `FL ${WINDOW} actuals`, borrowed: false },
  'MedRock TN': { packaging: 23_565.58, postage: 498_112.95, basis: `TN ${WINDOW} actuals`, borrowed: false },
  'MedRock TX': {
    packaging: 22_524.96 + 23_565.58,
    postage: 457_901.01 + 498_112.95,
    basis: `FL+TN pooled ${WINDOW} actuals (TX had no postage in the window)`,
    borrowed: true,
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function ratioOf(r: ShippingRatio): number {
  return r.packaging / r.postage;
}

/** postage × ratio at full precision, rounded once. */
export function shippingTarget(postage: number, r: ShippingRatio): number {
  return round2((postage * r.packaging) / r.postage);
}

/** A posted JournalEntry that already relieved this month by hand. */
export interface ManualRelief {
  docNumber: string;
  txnDate: string;
  /** Its credit to 1220.30. */
  amount: number;
}

export interface ShippingReliefInput {
  location: ShippingLocation;
  /** The close month, 'YYYY-MM'. */
  month: string;
  /** false while the month is still running. */
  monthEnded: boolean;
  /** false when QuickBooks could not be read — blocks the pool. */
  available: boolean;
  /** 5000.40 for the month. */
  postage: number;
  /** 5000.20 total for the month, as it stands in QuickBooks. */
  packagingCarried: number;
  /** 1220.30 at month-end — only used to flag a relief bigger than the asset. */
  assetBalance: number | null;
  manualReliefs: readonly ManualRelief[];
}

export interface ShippingReliefContribution extends JeContribution {
  /** postage × ratio. */
  target: number;
  /** What the lines book (0 → no lines). */
  relief: number;
  /** Retained on the header for the basis sheet; null when nothing was computed. */
  snapshot: ShippingReliefSnapshot | null;
}

/* Alias, not interface: persists straight into the jsonb snapshot column as a JsonValue. */
export type ShippingReliefSnapshot = {
  kind: 'shipping-relief';
  location: string;
  month: string;
  asOf: string;
  postage: number;
  ratioPackaging: number;
  ratioPostage: number;
  ratioBasis: string;
  target: number;
  packagingCarried: number;
  /** target − packagingCarried, before the floor at zero. */
  rawRelief: number;
  relief: number;
  manualDocNumbers: string[];
};

export function buildShippingReliefContribution(input: ShippingReliefInput, asOf: string): ShippingReliefContribution {
  const source = 'shipping-packaging' as const;
  const label = 'Shipping packaging relief';
  const empty = (warnings: string[], available: boolean): ShippingReliefContribution => ({
    source, label, lines: [], warnings, available, target: 0, relief: 0, snapshot: null,
  });
  const who = `${input.location} ${input.month}`;

  if (!input.available) {
    return empty([`${input.location}: shipping packaging could not be read from QuickBooks — entry blocked`], false);
  }
  if (!input.monthEnded) {
    return empty([`${who}: month has not ended — shipping packaging not relieved`], true);
  }

  const ratio = SHIPPING_RATIOS[input.location];
  const target = shippingTarget(input.postage, ratio);
  const carried = round2(input.packagingCarried);
  const rawRelief = round2(target - carried);
  const warnings: string[] = [];
  if (ratio.borrowed) {
    warnings.push(`${who}: shipping ratio borrowed — ${ratio.basis}`);
  }

  const snapshotOf = (relief: number): ShippingReliefSnapshot => ({
    kind: 'shipping-relief',
    location: input.location,
    month: input.month,
    asOf,
    postage: round2(input.postage),
    ratioPackaging: ratio.packaging,
    ratioPostage: ratio.postage,
    ratioBasis: ratio.basis,
    target,
    packagingCarried: carried,
    rawRelief,
    relief,
    manualDocNumbers: input.manualReliefs.map((m) => m.docNumber),
  });

  if (input.manualReliefs.length > 0) {
    const names = input.manualReliefs.map((m) => `${m.docNumber} $${m.amount.toFixed(2)}`).join(', ');
    warnings.push(`${who}: shipping packaging already relieved by hand (${names}) — nothing booked`);
    return { ...empty(warnings, true), target, snapshot: snapshotOf(0) };
  }
  if (rawRelief < 0) {
    warnings.push(
      `${who}: 5000.20 already carries $${carried.toFixed(2)}, above the $${target.toFixed(2)} target — ` +
        'nothing relieved; review whether packaging was expensed direct that should have been capitalized',
    );
    return { ...empty(warnings, true), target, snapshot: snapshotOf(0) };
  }
  if (rawRelief === 0) {
    return { ...empty(warnings, true), target, snapshot: snapshotOf(0) };
  }
  if (input.assetBalance !== null && rawRelief > round2(input.assetBalance)) {
    warnings.push(
      `${who}: relief $${rawRelief.toFixed(2)} exceeds the 1220.30 balance $${input.assetBalance.toFixed(2)} — ` +
        'the asset will go negative; review before posting',
    );
  }

  const pct = (ratioOf(ratio) * 100).toFixed(4);
  const memo =
    `Shipping packaging usage ${input.month}: postage ${round2(input.postage).toFixed(2)} × ${pct}% = ` +
    `${target.toFixed(2)}, less ${carried.toFixed(2)} already in 5000.20`;
  const expense: JournalLine = {
    postingType: 'Debit',
    amount: rawRelief,
    accountName: SHIPPING_RELIEF_EXPENSE_ACCOUNT,
    departmentName: null,
    className: null,
    memo,
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: [SHIPPING_RELIEF_SOURCE_KEY],
  };
  const asset: JournalLine = { ...expense, postingType: 'Credit', accountName: SHIPPING_RELIEF_ASSET_ACCOUNT };
  return {
    source, label, lines: [expense, asset], warnings, available: true,
    target, relief: rawRelief, snapshot: snapshotOf(rawRelief),
  };
}
