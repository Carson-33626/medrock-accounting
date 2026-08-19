/**
 * Closed-period posting locks (Carson, 2026-08-19): everything BEFORE the 04/10/2026
 * payroll — and month-end allocations through March 2026 — was completed by accounting
 * outside this system. Barbara keeps those drafts visible for comparisons, but they must
 * never post: a post would duplicate what accounting already booked.
 *
 * Same pattern as receipt-capture's PERIOD_FLOOR: a reviewed code constant, advanced
 * deliberately when accounting declares more periods complete. Enforced server-side in
 * the post/approve routes and surfaced as "Period complete" in the UI — the constant is
 * the single source of truth for both.
 */

/** Pay dates STRICTLY BEFORE this (MM/DD/YYYY compared as dates) are complete/locked.
 *  04/10/2026 itself is the first system-posted payroll and stays postable. */
export const PAYROLL_LOCKED_BEFORE_ISO = '2026-04-10';

/** Month-end allocation months up to AND INCLUDING this are complete/locked. */
export const EOM_LOCKED_THROUGH = '2026-03';

const MMDDYYYY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** 'MM/DD/YYYY' -> 'YYYY-MM-DD'; null when malformed (malformed dates are NOT locked —
 *  a lock must never hide a data bug behind a "complete" label). */
function payDateToIso(payDate: string): string | null {
  const m = MMDDYYYY.exec(payDate);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** True when a payroll header's pay date falls in a completed period. */
export function isPayrollPeriodComplete(payDate: string): boolean {
  const iso = payDateToIso(payDate);
  return iso !== null && iso < PAYROLL_LOCKED_BEFORE_ISO;
}

/** True when a month-end allocation month ('YYYY-MM') falls in a completed period. */
export function isEomMonthComplete(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= EOM_LOCKED_THROUGH;
}

/** The one sentence every surface shows for a locked period. */
export const PERIOD_COMPLETE_MESSAGE =
  'This period is complete — accounting already booked it. It stays here for comparison only; approving and posting are disabled.';
