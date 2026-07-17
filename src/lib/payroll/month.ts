import { parseAdpDate } from './dates';

export type Month = { year: number; month: number }; // month: 1-12

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function monthStart(m: Month): Date { return new Date(m.year, m.month - 1, 1); }
/** Day 0 of the next month === last day of this month, in local time. */
export function monthEnd(m: Month): Date { return new Date(m.year, m.month, 0); }

export function monthTag(m: Month): string { return `${m.year}.${pad2(m.month)}`; }
export function monthEndIso(m: Month): string { return `${m.year}-${pad2(m.month)}-${pad2(monthEnd(m).getDate())}`; }
export function nextMonthStartIso(m: Month): string {
  const y = m.month === 12 ? m.year + 1 : m.year;
  const mm = m.month === 12 ? 1 : m.month + 1;
  return `${y}-${pad2(mm)}-01`;
}
export function monthEndAdp(m: Month): string { return `${pad2(m.month)}/${pad2(monthEnd(m).getDate())}/${m.year}`; }

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function shortMonthName(m: Month): string { return SHORT[m.month - 1]; }
export function longMonthName(m: Month): string { return LONG[m.month - 1]; }

export function overlapsMonth(startAdp: string, endAdp: string, m: Month): boolean {
  const s = parseAdpDate(startAdp), e = parseAdpDate(endAdp);
  return s <= monthEnd(m) && e >= monthStart(m);
}
