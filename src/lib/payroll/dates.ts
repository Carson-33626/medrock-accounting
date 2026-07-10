import { parse, isWithinInterval } from 'date-fns';
export function parseAdpDate(s: string): Date {
  const d = parse(s.trim(), 'MM/dd/yyyy', new Date(2000, 0, 1));
  if (Number.isNaN(d.getTime())) throw new Error(`bad ADP date: ${s}`);
  return d;
}
export function inRange(payDate: string, startISO: string, endISO: string): boolean {
  return isWithinInterval(parseAdpDate(payDate), { start: new Date(startISO + 'T00:00:00'), end: new Date(endISO + 'T23:59:59') });
}

/** Converts an ADP-style MM/DD/YYYY date string to an ISO YYYY-MM-DD date string. */
export function adpDateToIso(mmddyyyy: string): string {
  const [month, day, year] = mmddyyyy.trim().split('/');
  return `${year}-${month}-${day}`;
}
