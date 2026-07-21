/**
 * Accounting-period → date-range helper for the JE landing filter (Barbara/Ash request 6:
 * view/filter journal entries by accounting period — monthly, quarterly, yearly). Pure and
 * timezone-safe: ISO bounds are string-formatted from the calendar components, never via
 * toISOString (which shifts a local-midnight Date back a day on UTC+ machines). No deps, so it
 * is safe to import in the client landing component.
 */
export type PeriodGranularity = 'month' | 'quarter' | 'year';

export interface PeriodRange {
  /** inclusive ISO start (YYYY-MM-DD) */
  start: string;
  /** inclusive ISO end (YYYY-MM-DD) */
  end: string;
  /** human label, e.g. "July 2026", "Q3 2026", "2026" */
  label: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Last calendar day of a 1-based month (leap-year aware). */
function lastDayOfMonth(year: number, month1: number): number {
  // Date(year, monthIndexExclusive, 0) rolls back to the last day of the prior index — with a
  // 1-based month that index IS the following month, so day 0 is this month's last day.
  return new Date(year, month1, 0).getDate();
}

export function periodToRange(
  granularity: PeriodGranularity,
  year: number,
  opts?: { month?: number; quarter?: number },
): PeriodRange {
  if (granularity === 'year') {
    return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
  }
  if (granularity === 'quarter') {
    const q = opts?.quarter ?? 1;
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = q * 3;
    return {
      start: `${year}-${pad2(startMonth)}-01`,
      end: `${year}-${pad2(endMonth)}-${pad2(lastDayOfMonth(year, endMonth))}`,
      label: `Q${q} ${year}`,
    };
  }
  const m = opts?.month ?? 1;
  return {
    start: `${year}-${pad2(m)}-01`,
    end: `${year}-${pad2(m)}-${pad2(lastDayOfMonth(year, m))}`,
    label: `${MONTHS[m - 1]} ${year}`,
  };
}
