/**
 * The shipping-packaging accrual as postable journal entries.
 *
 * `shipping-packaging-accrual.ts` decides HOW MUCH; this decides what that becomes
 * on the books. Split the same way `lab-supplies-je.ts` is split from its model:
 * the sizing is a measured fit that will be re-fitted, the posting shape is an
 * accounting decision that should not move when the fit does.
 *
 * WHICH COGS ACCOUNT — MEASURED, NOT REASONED FROM NAMES
 *
 * The chart offers five plausible offsets (5000.15 Compound Packaging, 5000.20
 * Final Packaging Materials, 5000.40 Postage/Shipping Cost, 5000.45 Shipping &
 * Handling - COGS Purchases, and the bare parent). Rather than pick by name,
 * `_probe-shipping-offsets.ts` read the OTHER side of every journal entry that has
 * ever touched 1220.30 since 2024-01-01. The pairing is exact and one-to-one in
 * both entities with history:
 *
 *   FL  Dr 5000.20 Final Packaging Materials  91,497.53   (27 entries)
 *   TN  Dr 5000.20 Final Packaging Materials 153,992.56   (25 entries)
 *
 * — while every other inventory account on those same entries pairs off against
 * its own COGS line to the cent (5000.10 <-> 1220.10, 5000.15 <-> 1220.15,
 * 5000.05 <-> 1220.05, 5000.35 <-> 1220.25). 5000.20 is what the accountant uses
 * for 1220.30, so that is what this uses.
 *
 * WHAT IT CREDITS, AND WHY NOT INVENTORY
 *
 * The same correction `lab-supplies-je.ts` had to make. Crediting 1220.30 is right
 * for RELIEVING stock that is on the books; the close does that on its own. An
 * accrual covers packaging RECEIVED WHERE NO BILL HAS BEEN KEYED — nothing has
 * landed in 1220.30 for it, so there is no asset to relieve, and crediting it
 * anyway would drive it negative by the accrued amount. What is missing is the
 * liability for goods received and not yet billed:
 *
 *   Dr 5000.20  Cost of Goods Sold:Final Packaging Materials
 *   Cr 2011     Accrued Expenses
 *
 * `2011 Accrued Expenses` re-verified present in all three realms on 2026-09-04
 * (FL -33,039.04, TN -22,502.06, TX -14,641.13). FOCAS carries neither account and
 * is excluded — it ships nothing.
 *
 * WHY IT REVERSES RATHER THAN NETTING
 *
 * Once the real bills arrive they are coded to 1220.30 and the close expenses them,
 * so an accrual left standing would double-count exactly the spend it covered. It
 * posts as an accrual/reversal PAIR, month-end and the first of the following
 * month, so each month stands alone and no balance accumulates in 2011 that
 * someone has to remember to unwind.
 */
import type { Entity, JournalDraft, JournalLine } from '@/lib/payroll/types';
import type { JeContribution } from './je-pool';
import type { ShippingAccrualResult, ShippingLocation } from './shipping-packaging-accrual';

/** QB `FullyQualifiedName`s — the key `fetchDimensions` indexes accounts by.
 *  A bare account number here resolves to NOTHING and silently makes the entry
 *  unpostable, which is how the 2026-08-24 close JEs were broken. */
export const SHIPPING_EXPENSE_ACCOUNT = 'Cost of Goods Sold:Final Packaging Materials';
export const ACCRUED_EXPENSES_ACCOUNT = 'Accrued Expenses';

/** Its own pay_group, so these never collide with the close's `INV CLOSE`, the
 *  cutover's `INV OPEN`, or `LAB ACCRUAL` in the header table's natural key. */
export const SHIPPING_ACCRUAL_PAY_GROUP = 'SHIP ACCRUAL';

export const SHIPPING_ENTITY_BY_LOCATION: Readonly<Record<ShippingLocation, Entity>> = {
  'MedRock FL': 'MedRock FL',
  'MedRock TN': 'MedRock TN',
  'MedRock TX': 'MedRock TX',
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 'YYYY-MM' -> 'YYYY.MM', the DocNumber convention the other kinds use. */
export function monthTag(month: string): string {
  return month.replace('-', '.');
}

/** Last day of a 'YYYY-MM', ISO. */
export function monthEndIso(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** First day of the month AFTER a 'YYYY-MM', ISO — where the reversal posts. */
export function nextMonthStartIso(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** ISO 'YYYY-MM-DD' -> ADP 'MM/DD/YYYY', the header table's `pay_date` format. */
function isoToAdp(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export interface ShippingAccrualDraftInput {
  location: ShippingLocation;
  /** 'YYYY-MM' */
  month: string;
  /** From `computeShippingAccrual` — the estimate of what is not yet keyed. */
  accrual: number;
  /** For the memo, so a reader can see how sure the number is without leaving QB. */
  completeness: number;
  zeroEntryOverride: boolean;
}

export interface ShippingAccrualDraftPair {
  accrual: JournalDraft;
  reversal: JournalDraft;
}

/**
 * The QuickBooks identity of one half of the pair.
 *
 * Exported and shared by the draft builder and any post path, which re-derive
 * DocNumber/TxnDate/PrivateNote rather than trusting a stored row — if they
 * derived them independently the two could disagree about what the same entry is
 * called.
 */
export function shippingAccrualIdentity(
  month: string,
  kind: 'accrual' | 'reversal',
): { docNumber: string; txnDateIso: string; privateNote: string } {
  const tag = monthTag(month);
  if (kind === 'reversal') {
    return {
      docNumber: `SP Accru ${tag}R`,
      txnDateIso: nextMonthStartIso(month),
      privateNote: `Reverse of JE SP Accru ${tag}`,
    };
  }
  return {
    docNumber: `SP Accru ${tag}`,
    txnDateIso: monthEndIso(month),
    privateNote:
      `Shipping packaging accrual — ${month}. Estimated 1220.30 spend not yet entered in ` +
      'QuickBooks. Shipping and cold-chain materials never enter LifeFile, so FIFO cannot see ' +
      'them and the driver is the buy orders (Carson, 2026-09-04). Reverses on the first of the ' +
      'following month.',
  };
}

/** The memo both lines carry — says how sure the number is, in QuickBooks. */
export function shippingAccrualMemo(input: ShippingAccrualDraftInput): string {
  const basis = input.zeroEntryOverride
    ? 'no documents keyed yet'
    : `${Math.round(input.completeness * 100)}% complete for its age`;
  return `Shipping packaging accrued — ${input.month} (${basis})`;
}

/** The two balanced lines, or an empty array when there is nothing to accrue. */
export function buildShippingAccrualLines(
  input: ShippingAccrualDraftInput,
  flip = false,
): JournalLine[] {
  const amount = round2(input.accrual);
  if (amount <= 0) return [];
  const memo = shippingAccrualMemo(input);
  return [
    {
      postingType: flip ? 'Credit' : 'Debit',
      amount,
      accountName: SHIPPING_EXPENSE_ACCOUNT,
      departmentName: null,
      className: null,
      memo,
      creditBucket: null,
      origin: 'generated',
      sourceRowKeys: [],
    },
    {
      postingType: flip ? 'Debit' : 'Credit',
      amount,
      accountName: ACCRUED_EXPENSES_ACCOUNT,
      departmentName: null,
      className: null,
      memo,
      creditBucket: null,
      origin: 'generated',
      sourceRowKeys: [],
    },
  ];
}

/**
 * The accrual/reversal pair for one location-month, or null when there is nothing
 * to accrue.
 *
 * Returns null at a zero (or negative) accrual rather than a balanced pair of
 * zero-amount lines: QuickBooks accepts them, and a shelf of $0.00 entries is
 * noise an accountant then reads past every month to find the real ones.
 */
export function buildShippingAccrualDrafts(
  input: ShippingAccrualDraftInput,
): ShippingAccrualDraftPair | null {
  const amount = round2(input.accrual);
  if (amount <= 0) return null;

  const entity = SHIPPING_ENTITY_BY_LOCATION[input.location];
  const monthEnd = monthEndIso(input.month);
  const accrualId = shippingAccrualIdentity(input.month, 'accrual');
  const reversalId = shippingAccrualIdentity(input.month, 'reversal');

  // THE TWO HALVES MUST NOT SHARE A pay_date. `saveDraft`'s natural key is
  // (entity, pay_date, pay_group, period_segment) — `kind` is NOT in it — so a
  // pair posted on one pay_date would upsert over itself and only the reversal
  // would survive. Each half therefore carries its own posting date, which is also
  // the honest reading of `pay_date`: the day the entry lands. Consecutive months
  // cannot collide either — a reversal is dated the 1st, an accrual the month-end.
  const period = {
    payGroup: SHIPPING_ACCRUAL_PAY_GROUP,
    periodStart: `${input.month}-01`,
    periodEnd: monthEnd,
  };

  return {
    accrual: {
      entity,
      kind: 'accrual',
      payDate: isoToAdp(monthEnd),
      ...period,
      docNumber: accrualId.docNumber,
      txnDate: accrualId.txnDateIso,
      privateNote: accrualId.privateNote,
      lines: buildShippingAccrualLines(input, false),
      totalDebits: amount,
      totalCredits: amount,
      variance: 0,
      rowKeys: [],
    },
    reversal: {
      entity,
      kind: 'reversal',
      payDate: isoToAdp(reversalId.txnDateIso),
      ...period,
      docNumber: reversalId.docNumber,
      txnDate: reversalId.txnDateIso,
      privateNote: reversalId.privateNote,
      lines: buildShippingAccrualLines(input, true),
      totalDebits: amount,
      totalCredits: amount,
      variance: 0,
      rowKeys: [],
    },
  };
}

export interface ShippingContributionInput {
  location: ShippingLocation;
  /** 'YYYY-MM' */
  month: string;
  /** null when this location's QuickBooks realm could not be read. */
  result: ShippingAccrualResult | null;
}

/**
 * The pooled-JE contribution for ONE entity-month.
 *
 * Only the ACCRUAL half goes in the pool. The reversal is dated the first of the
 * NEXT month and belongs to that month's entry — folding it in here would put two
 * different posting dates on one QuickBooks document, which QuickBooks cannot
 * express. `buildShippingAccrualDrafts` remains the path for the standalone pair.
 *
 * An unreadable realm reports `available: false` with no lines, which is what stops
 * `assemblePool` posting an entry that is quietly missing a piece. A month that
 * genuinely has nothing to accrue is available with zero lines — the pool keeps it
 * in `subtotals` at zero so a reviewer can tell "ran, nothing to accrue" from
 * "never ran".
 */
export function buildShippingContribution(input: ShippingContributionInput): JeContribution {
  const label = 'Shipping packaging accrual';
  if (input.result === null) {
    return {
      source: 'shipping-packaging',
      label,
      lines: [],
      warnings: [`${input.location}: QuickBooks could not be read — shipping accrual unavailable.`],
      available: false,
    };
  }

  const r = input.result;
  const lines = buildShippingAccrualLines({
    location: input.location,
    month: input.month,
    accrual: r.accrual,
    completeness: r.completeness,
    zeroEntryOverride: r.zeroEntryOverride,
  });

  const warnings: string[] = [];
  if (r.flagReason !== null) warnings.push(`${input.location} ${input.month}: ${r.flagReason}`);
  if (r.borrowedCurve) {
    warnings.push(
      `${input.location}: completeness uses the pooled FL+TN curve — TX has one settled month ` +
        'of its own and cannot be fitted yet.',
    );
  }

  return { source: 'shipping-packaging', label, lines, warnings, available: true };
}
