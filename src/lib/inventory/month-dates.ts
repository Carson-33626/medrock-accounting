/** 'YYYY-MM' → { asOf: last day of that month, opening: first day of next month } as M/D/YYYY. */
export function monthDates(month: string): { asOf: string; opening: string; openingLong: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return { asOf: month, opening: month, openingLong: month };
  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10); // 1..12
  const last = new Date(Date.UTC(year, mon, 0)); // day 0 of next month = last day of this month
  const open = new Date(Date.UTC(year, mon, 1)); // first day of next month
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  const fmtLong = (d: Date) =>
    d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return { asOf: fmt(last), opening: fmt(open), openingLong: fmtLong(open) };
}
