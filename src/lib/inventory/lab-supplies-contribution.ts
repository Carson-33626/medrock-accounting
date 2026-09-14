/**
 * The lab-supplies accrual as a CONTRIBUTOR to the monthly close entry — not its
 * own entry, not a reversing pair.
 *
 * Carson, 2026-09-14: *"we need to fold lab supplies into the main journal entry,
 * not a separate piece, so it generates on journal entry generation."* The shape
 * was ruled on 2026-09-03 (ds-one-inventory-je §3, "fill backwards, true up"):
 *
 *   this month's line = target accrued balance (computed from scratch)
 *                     − the sum of our own posted lab-supplies lines to date
 *
 * Neither term is remembered. The TARGET is the accrued liability that should
 * stand at this month-end: for every month up to and including this one, the part
 * of that month's lab-supplies spend the completeness curve says is still unkeyed
 * (`computeAccrual`, read as of today — a month whose bills have all landed
 * contributes $0). The POSTED total is a query over our own audited lines. A month
 * that went wrong is corrected by the next one automatically; nothing accumulates
 * an error forward, and no reversal is needed because the balance is re-set every
 * month rather than stacked.
 *
 * Same accounts as the retired pair: Dr 5000.25 Cost of Goods Sold:Lab Supplies /
 * Cr 2011 Accrued Expenses (a negative delta flips them).
 *
 * Pure. The server assembles the inputs; this decides the lines.
 */
import type { JournalLine } from '@/lib/payroll/types';
import type { JeContribution } from './je-pool';
import { LAB_SUPPLIES_EXPENSE_ACCOUNT, ACCRUED_EXPENSES_ACCOUNT } from './lab-supplies-je';
import type { LabSuppliesAccrualMonth } from './lab-supplies-server';

/**
 * Stamped into `sourceRowKeys` on every lab-supplies line, so the posted total can
 * be queried back out of `payroll_journal_lines` without parsing memos. The DS
 * asked for exactly this: "a posted line can be traced back to the system that
 * produced it. Without that, a pooled entry is unauditable."
 */
export const LAB_SUPPLIES_SOURCE_KEY = 'src:lab-supplies';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LabSuppliesContributionInput {
  location: string;
  /** The close month, 'YYYY-MM'. */
  month: string;
  /** Accrual rows for THIS location, as of today, any month (extra months are ignored). */
  months: readonly LabSuppliesAccrualMonth[];
  /** Σ of our posted lab-supplies lines to date: credits to 2011 minus debits. */
  postedToDate: number;
  /** false while the month is still running — an accrual is a month-end act. */
  monthEnded: boolean;
  /** false when the QuickBooks read behind `months` failed — blocks the pool. */
  available: boolean;
}

export interface LabSuppliesContribution extends JeContribution {
  /** The accrued balance that should stand at this month-end. */
  target: number;
  /** target − postedToDate: what the lines book (0 → no lines). */
  delta: number;
  /** The months that make up the target, for the source-detail sheet. */
  basis: LabSuppliesAccrualMonth[];
}

export function buildLabSuppliesContribution(input: LabSuppliesContributionInput): LabSuppliesContribution {
  const source = 'lab-supplies' as const;
  const label = 'Lab supplies accrual';
  const empty = (warnings: string[], available: boolean): LabSuppliesContribution => ({
    source,
    label,
    lines: [],
    warnings,
    available,
    target: 0,
    delta: 0,
    basis: [],
  });

  if (!input.available) {
    return empty([`${input.location}: lab-supplies accrual could not be read from QuickBooks — entry blocked`], false);
  }
  if (!input.monthEnded) {
    return empty(
      [`${input.location}: ${input.month} has not ended — lab supplies not accrued (an accrual is a month-end act)`],
      true,
    );
  }

  const basis = input.months
    .filter((m) => m.location === input.location && m.month <= input.month && m.accrual > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  const target = round2(basis.reduce((s, m) => s + m.accrual, 0));
  const posted = round2(input.postedToDate);
  const delta = round2(target - posted);
  const warnings = basis.filter((m) => m.flagged && m.flagReason).map((m) => `${input.location} ${m.month}: ${m.flagReason}`);

  if (Math.abs(delta) < 0.005) {
    return { ...empty(warnings, true), target, basis };
  }

  const amount = round2(Math.abs(delta));
  const memo =
    `Lab supplies accrual — set accrued balance to $${target.toFixed(2)} ` +
    `(posted to date $${posted.toFixed(2)}); unkeyed spend per completeness curve`;
  const expense: JournalLine = {
    postingType: delta > 0 ? 'Debit' : 'Credit',
    amount,
    accountName: LAB_SUPPLIES_EXPENSE_ACCOUNT,
    departmentName: null,
    className: null,
    memo,
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: [LAB_SUPPLIES_SOURCE_KEY],
  };
  const liability: JournalLine = {
    ...expense,
    postingType: delta > 0 ? 'Credit' : 'Debit',
    accountName: ACCRUED_EXPENSES_ACCOUNT,
  };
  return { source, label, lines: [expense, liability], warnings, available: true, target, delta, basis };
}
