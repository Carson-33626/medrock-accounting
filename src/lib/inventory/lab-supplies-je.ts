/**
 * The lab-supplies accrual as a postable pair of journal entries.
 *
 * `lab-supplies-accrual.ts` decides HOW MUCH; this decides what that becomes on
 * the books. Kept apart because the sizing is a measured model that will be
 * re-fitted, while the posting shape is an accounting decision that should not
 * move when the model does.
 *
 * WHAT IT CREDITS, AND WHY NOT INVENTORY
 *
 * The COGS tab originally described this as `Dr 5000.25 / Cr 1220.20 Lab Supplies
 * Inventory`. That is the right pair for RELIEVING stranded inventory, and the
 * FIFO close already emits it — Tennessee's 2026-03 close carries
 * `Dr COGS:Lab Supplies 1,696.52 / Cr Inventory Asset:Lab Supplies Inventory
 * 1,696.52` against a FIFO target of zero, because the category was excluded from
 * the ledger and the whole book balance now writes off. That happens on its own,
 * every month, for whatever has actually been entered.
 *
 * It is the WRONG pair for an accrual. An accrual covers supplies received where
 * no bill has been keyed at all — nothing has landed in 1220.20 for it, so there
 * is no asset to relieve. Crediting the asset anyway would drive it negative by
 * the accrued amount every month, on top of the close already writing it to zero.
 * What is missing is the LIABILITY for goods received and not yet billed:
 *
 *   Dr 5000.25 Cost of Goods Sold:Lab Supplies
 *   Cr 2011    Accrued Expenses
 *
 * `2011 Accrued Expenses` verified present in all three posting realms on
 * 2026-09-03 (FL −33,039.04, TN −22,502.06, TX −14,641.13). FOCAS carries neither
 * 5000.25 nor 1220.20 and is excluded — it buys no lab supplies.
 *
 * WHY IT REVERSES RATHER THAN NETTING
 *
 * The accrual estimates the part of a month nobody has keyed yet. Once those bills
 * arrive they are coded to 1220.20 and the close expenses them — so an accrual
 * left standing would double-count exactly the spend it was covering. It is
 * therefore posted as an accrual/reversal PAIR, month-end and the first of the
 * following month, the same shape `payroll/accrual.ts` uses for payroll. Each
 * month then stands alone and no balance accumulates in 2011 that someone has to
 * remember to unwind.
 *
 * A running-delta alternative (post only the change in the accrued balance) was
 * rejected: it leaves a permanent balance in 2011 whose correctness depends on
 * every prior month's estimate, and it is not the shape an accountant reviewing
 * 2011 expects to find.
 */
import type { JournalDraft, JournalLine } from '@/lib/payroll/types';
import type { Entity } from '@/lib/payroll/types';
import type { AccrualLocation } from './lab-supplies-accrual';

/** QB `FullyQualifiedName`s — the key `fetchDimensions` indexes accounts by.
 *  A bare account number here resolves to NOTHING and silently makes the entry
 *  unpostable, which is how the 2026-08-24 close JEs were broken. */
export const LAB_SUPPLIES_EXPENSE_ACCOUNT = 'Cost of Goods Sold:Lab Supplies';
export const ACCRUED_EXPENSES_ACCOUNT = 'Accrued Expenses';

/** Its own pay_group, so these never collide with the close's month-end drafts
 *  (`INV CLOSE`) or the cutover (`INV OPEN`) in the header table's natural key. */
export const LAB_ACCRUAL_PAY_GROUP = 'LAB ACCRUAL';

export const ACCRUAL_ENTITY_BY_LOCATION: Readonly<Record<AccrualLocation, Entity>> = {
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

export interface LabAccrualDraftInput {
  location: AccrualLocation;
  /** 'YYYY-MM' */
  month: string;
  /** From `computeAccrual` — the estimate of what is not yet keyed. */
  accrual: number;
  /** For the memo, so a reader can see how sure the number is without leaving QB. */
  completeness: number;
  boundBy: 'curve' | 'entry';
}

export interface LabAccrualDraftPair {
  accrual: JournalDraft;
  reversal: JournalDraft;
}

/**
 * The accrual/reversal pair for one location-month, or null when there is
 * nothing to accrue.
 *
 * Returns null at a zero (or negative) accrual rather than a balanced pair of
 * zero-amount lines: QuickBooks accepts them, and a shelf of $0.00 entries is
 * noise an accountant then has to read past every month to find the real ones.
 */
/**
 * The QuickBooks identity of one half of the pair.
 *
 * Exported and used by BOTH the draft builder and the post route. The post route
 * re-derives DocNumber/TxnDate/PrivateNote rather than trusting the stored draft
 * (a stale row must not decide what lands in QuickBooks), so if it derived them
 * independently the two could disagree about what the same entry is called.
 */
export function labAccrualIdentity(
  month: string,
  kind: 'accrual' | 'reversal',
): { docNumber: string; txnDateIso: string; privateNote: string } {
  const tag = monthTag(month);
  if (kind === 'reversal') {
    return {
      docNumber: `LS Accru ${tag}R`,
      txnDateIso: nextMonthStartIso(month),
      privateNote: `Reverse of JE LS Accru ${tag}`,
    };
  }
  return {
    docNumber: `LS Accru ${tag}`,
    txnDateIso: monthEndIso(month),
    privateNote:
      `Lab supplies accrual — ${month}. Estimated spend not yet entered in QuickBooks; ` +
      'lab supplies are bought ad hoc and do not route through LifeFile, so FIFO cannot see them. ' +
      'Reverses on the first of the following month.',
  };
}

export function buildLabAccrualDrafts(input: LabAccrualDraftInput): LabAccrualDraftPair | null {
  const amount = round2(input.accrual);
  if (amount <= 0) return null;

  const entity = ACCRUAL_ENTITY_BY_LOCATION[input.location];
  const monthEnd = monthEndIso(input.month);
  const accrualId = labAccrualIdentity(input.month, 'accrual');
  const reversalId = labAccrualIdentity(input.month, 'reversal');
  const pct = Math.round(input.completeness * 100);
  const basis =
    input.boundBy === 'entry'
      ? `${pct}% of documents keyed`
      : `${pct}% complete for its age`;
  const memo = `Lab supplies accrued — ${input.month} (${basis})`;

  const lines = (flip: boolean): JournalLine[] => [
    {
      postingType: flip ? 'Credit' : 'Debit',
      amount,
      accountName: LAB_SUPPLIES_EXPENSE_ACCOUNT,
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

  // THE TWO HALVES MUST NOT SHARE A pay_date. `saveDraft`'s natural key is
  // (entity, pay_date, pay_group, period_segment) — `kind` is NOT in it — so a
  // pair posted on one pay_date would upsert over itself and only the reversal
  // would survive. `payroll/accrual.ts` gives both halves the same month-end and
  // would hit exactly that; it has no production caller, so it never had to.
  //
  // Each half therefore carries its own posting date, which is also the honest
  // reading of `pay_date`: the day the entry lands. Consecutive months cannot
  // collide either — a reversal is dated the 1st and an accrual the month-end.
  const period = {
    payGroup: LAB_ACCRUAL_PAY_GROUP,
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
      lines: lines(false),
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
      lines: lines(true),
      totalDebits: amount,
      totalCredits: amount,
      variance: 0,
      rowKeys: [],
    },
  };
}
