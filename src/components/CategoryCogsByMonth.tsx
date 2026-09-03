'use client';

import {
  buildCogsGrid,
  cogsCell,
  isExcludedMonth,
  monthFlag,
  monthLabel,
  monthTotal,
  spansYears,
} from '@/lib/inventory/cogs-view';
import type { CategoryCogsSeriesRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/**
 * COGS by category by month — the shape the accountants read the QuickBooks
 * 5000.xx P&L in (Carson, 2026-09-03).
 *
 * Which months are and are not operating cost of goods is decided in
 * `lib/inventory/cogs-view` and never here, so the close panel's copy of this
 * grid and the FIFO page's COGS tab cannot drift apart on the one question that
 * matters. Read the module header for why the cutover and true-up months are
 * shown-and-struck rather than dropped.
 *
 * `location` accepts 'all', which aggregates every location into one grid.
 *
 * ONE CONSUMER, ONE SHAPE: the close panel, beneath a single location's journal
 * entry. A wider `full` variant used to serve the FIFO page's COGS tab as well;
 * that tab became a two-month roll-forward on 2026-09-03 (a nine-column grid
 * answers "how has the year gone", not the question asked at the close), so the
 * variant went with it rather than sitting here unused.
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
  const grid = buildCogsGrid(rows, { location, firstAnchoredMonth });
  if (grid.months.length === 0) return null;

  const withYear = spansYears(grid.months);
  const th = `px-2 py-1 text-left font-medium ${subText}`;
  const cell = 'px-2 py-1 text-right tabular-nums';
  const anyExcluded = grid.months.some((m) => isExcludedMonth(grid, m));

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
              {grid.months.map((m) => (
                <th key={m} className={`${th} text-right whitespace-nowrap`}>
                  {monthLabel(m, withYear)}
                  {monthFlag(grid, m) === 'cutover' && (
                    <span
                      title="Cutover month — carries the catch-up write-off from every month before the anchor window. Not operating COGS; excluded from the total."
                      className="ml-1 text-[9px] px-1 rounded bg-amber-500/20 text-amber-600 font-semibold uppercase cursor-help"
                    >
                      cutover
                    </span>
                  )}
                  {monthFlag(grid, m) === 'true-up' && (
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
            {grid.categories.map((c) => (
              <tr key={c} className={`border-b last:border-0 ${border}`}>
                <td className="px-2 py-1 font-medium">{c}</td>
                {grid.months.map((m) => {
                  const v = cogsCell(grid, m, c);
                  return (
                    <td
                      key={m}
                      className={`${cell} ${isExcludedMonth(grid, m) ? `line-through ${subText}` : ''}`}
                    >
                      {v === 0 ? '—' : usd.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className={`border-t-2 font-semibold ${border}`}>
              <td className="px-2 py-1">Operating COGS</td>
              {grid.months.map((m) => (
                <td key={m} className={`${cell} ${isExcludedMonth(grid, m) ? subText : ''}`}>
                  {isExcludedMonth(grid, m) ? '—' : usd.format(monthTotal(grid, m))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {anyExcluded && (
        <p className={`text-[11px] mt-1 ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}>
          Struck-through months are excluded from Operating COGS: the cutover month is the
          one-time catch-up write-off, and a negative month is the anchor truing value up.
        </p>
      )}
    </div>
  );
}
