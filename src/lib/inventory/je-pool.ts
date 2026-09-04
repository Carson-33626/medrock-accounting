/**
 * The inventory journal entry, assembled from sub-pools.
 *
 * Carson, 2026-09-03: *"this journal entry page is getting too many systems. I want
 * 1 pool, 1 journal entry section, and then these sub-pools can generate inside the
 * pool section so this turns into 1 journal entry, not 4 with the same page."*
 *
 * One month's inventory could otherwise be five QuickBooks entries per entity — the
 * FIFO close, the opening correction, a lab-supplies accrual, its reversal, and
 * device standard cost. Each defensible alone; together, a mess to review.
 *
 * A contributor is a pure `(entity, month) → JeContribution`. This module takes
 * their lines and produces ONE balanced entry.
 *
 * WHY IT CONCATENATES RATHER THAN NETTING BY ACCOUNT
 *
 * Two contributors can legitimately touch the same account, and merging their lines
 * would destroy exactly what the pooling is supposed to preserve: Ash still has to
 * see what the FIFO adjustment was versus what the accrual was. QuickBooks accepts
 * repeated accounts on one entry, so the lines stay separate and carry their own
 * memos. The point is one ENTRY, not one undifferentiated number.
 *
 * See `docs/fifo-monthly-close/ds-one-inventory-je-2026-09-03.md`.
 */
import type { JournalLine } from '@/lib/payroll/types';

/** A stable id for the system that produced a set of lines. */
export type JeSource =
  | 'fifo-category'
  | 'lab-supplies'
  | 'device-standard-cost'
  | 'otc-items'
  | 'shipping-packaging';

export interface JeContribution {
  source: JeSource;
  /** What the reviewer sees against the subtotal — 'FIFO category adjustment'. */
  label: string;
  lines: JournalLine[];
  /** Surfaced on the card and in the generate response, never swallowed. */
  warnings: string[];
  /**
   * false when the contributor could not compute — a QuickBooks realm that would
   * not answer, a ledger read that failed. The pool then refuses to post rather
   * than shipping an entry that is quietly missing a piece.
   */
  available: boolean;
}

export interface PoolSubtotal {
  source: JeSource;
  label: string;
  lineCount: number;
  debits: number;
  credits: number;
}

export interface AssembledPool {
  lines: JournalLine[];
  totalDebits: number;
  totalCredits: number;
  /** debits − credits; the generate path refuses to save anything non-zero. */
  variance: number;
  /** Per contributor, in the order given — what the card renders. */
  subtotals: PoolSubtotal[];
  warnings: string[];
  /**
   * Contributors that reported `available: false`. Non-empty means the entry is
   * incomplete and must not post.
   */
  unavailable: JeSource[];
  /** True only when every contributor is available AND the entry balances. */
  postable: boolean;
}

/** Σ in integer cents — two groupings of the same lines cannot land a cent apart. */
function sumCents(lines: readonly JournalLine[], side: 'Debit' | 'Credit'): number {
  let cents = 0;
  for (const l of lines) {
    if (l.postingType === side) cents += Math.round(l.amount * 100);
  }
  return cents / 100;
}

/**
 * Assemble the contributors into one entry.
 *
 * A contributor with no lines is kept in `subtotals` at zero rather than dropped:
 * "the lab-supplies accrual ran and had nothing to accrue" and "the lab-supplies
 * accrual never ran" are different facts, and the reviewer needs to tell them
 * apart. An UNAVAILABLE contributor is different again — that one blocks posting.
 */
export function assemblePool(contributions: readonly JeContribution[]): AssembledPool {
  const lines: JournalLine[] = [];
  const subtotals: PoolSubtotal[] = [];
  const warnings: string[] = [];
  const unavailable: JeSource[] = [];

  for (const c of contributions) {
    if (!c.available) unavailable.push(c.source);
    // An unavailable contributor contributes no lines even if it produced some —
    // a partial read must never become a posted number.
    const own = c.available ? c.lines : [];
    lines.push(...own);
    subtotals.push({
      source: c.source,
      label: c.label,
      lineCount: own.length,
      debits: sumCents(own, 'Debit'),
      credits: sumCents(own, 'Credit'),
    });
    for (const w of c.warnings) warnings.push(w);
  }

  const totalDebits = sumCents(lines, 'Debit');
  const totalCredits = sumCents(lines, 'Credit');
  const variance = Math.round((totalDebits - totalCredits) * 100) / 100;

  return {
    lines,
    totalDebits,
    totalCredits,
    variance,
    subtotals,
    warnings,
    unavailable,
    postable: unavailable.length === 0 && variance === 0 && lines.length > 0,
  };
}
