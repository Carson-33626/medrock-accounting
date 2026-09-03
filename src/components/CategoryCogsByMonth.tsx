'use client';

import type { CategoryCogsSeriesRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** 'YYYY-MM' -> 'Mar' */
function monthLabel(month: string): string {
  const m = Number(month.slice(5, 7));
  return ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] ?? month;
}

/**
 * COGS by category by month, for one location — the shape the accountants read the
 * QuickBooks 5000.xx P&L in (Carson, 2026-09-03).
 *
 * TWO MONTHS ARE NOT OPERATING COGS, and both are labelled rather than dropped:
 *
 *  - the FIRST ANCHORED month carries the catch-up write-off from every unanchored
 *    month before it ($2,170,590 combined at 2026-01 against ~$290k in a normal
 *    month). Shown, struck through, and excluded from the total — a $2.2M January
 *    read as cost of goods would be a serious misreading.
 *  - a NEGATIVE month is the current-month lot anchor truing value back UP, not a
 *    credit to cost of goods.
 *
 * Both are derived, never hardcoded to a date: the first is `min(as_of_month)`
 * where the ledger is anchored, the second is simply the sign.
 */
export default function CategoryCogsByMonth({
  rows,
  location,
  firstAnchoredMonth,
  darkMode,
  subText,
  border,
}: {
  rows: CategoryCogsSeriesRow[];
  location: string;
  firstAnchoredMonth: string | null;
  darkMode: boolean;
  subText: string;
  border: string;
}) {
  const mine = rows.filter((r) => r.location === location);
  if (mine.length === 0) return null;

  const months = [...new Set(mine.map((r) => r.month))].sort();
  const categories = [...new Set(mine.map((r) => r.qbCategory))].sort();
  const byKey = new Map<string, number>();
  for (const r of mine) byKey.set(`${r.month}|${r.qbCategory}`, r.cogs);

  const monthTotal = (m: string): number =>
    categories.reduce((s, c) => s + (byKey.get(`${m}|${c}`) ?? 0), 0);

  const isCutover = (m: string): boolean => m === firstAnchoredMonth;
  const isTrueUp = (m: string): boolean => monthTotal(m) < 0;
  const excluded = (m: string): boolean => isCutover(m) || isTrueUp(m);

  const th = `px-2 py-1 text-left font-medium ${subText}`;
  const cell = 'px-2 py-1 text-right tabular-nums';

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold">COGS by category by month</p>
      <p className={`text-[11px] mt-0.5 ${subText}`}>
        What actually moved out of inventory each month, on the same basis this entry posts.
        Compare against QuickBooks <span className="font-medium">5000.xx</span> — where these are
        blank in QuickBooks, no close entry was ever posted for that month.
      </p>
      <div className="overflow-x-auto mt-1.5">
        <table className="w-full text-xs">
          <thead>
            <tr className={`border-b ${border}`}>
              <th className={th}>Category</th>
              {months.map((m) => (
                <th key={m} className={`${th} text-right whitespace-nowrap`}>
                  {monthLabel(m)}
                  {isCutover(m) && (
                    <span
                      title="Cutover month — carries the catch-up write-off from every month before the anchor window. Not operating COGS; excluded from the total."
                      className="ml-1 text-[9px] px-1 rounded bg-amber-500/20 text-amber-600 font-semibold uppercase cursor-help"
                    >
                      cutover
                    </span>
                  )}
                  {!isCutover(m) && isTrueUp(m) && (
                    <span
                      title="Negative: the current-month lot anchor is truing value back UP, not crediting cost of goods. Excluded from the total."
                      className="ml-1 text-[9px] px-1 rounded bg-sky-500/20 text-sky-600 font-semibold uppercase cursor-help"
                    >
                      true-up
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c} className={`border-b last:border-0 ${border}`}>
                <td className="px-2 py-1 font-medium">{c}</td>
                {months.map((m) => {
                  const v = byKey.get(`${m}|${c}`) ?? 0;
                  return (
                    <td
                      key={m}
                      className={`${cell} ${excluded(m) ? `line-through ${subText}` : ''}`}
                    >
                      {v === 0 ? '—' : usd.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className={`border-t-2 font-semibold ${border}`}>
              <td className="px-2 py-1">Operating COGS</td>
              {months.map((m) => (
                <td key={m} className={`${cell} ${excluded(m) ? subText : ''}`}>
                  {excluded(m) ? '—' : usd.format(monthTotal(m))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {months.some(excluded) && (
        <p className={`text-[11px] mt-1 ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}>
          Struck-through months are excluded from Operating COGS: the cutover month is the
          one-time catch-up write-off, and a negative month is the anchor truing value up.
        </p>
      )}
    </div>
  );
}
