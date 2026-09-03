'use client';

import {
  buildCogsGrid,
  categoryOperatingTotal,
  cogsCell,
  isExcludedMonth,
  monthFlag,
  monthLabel,
  monthTotal,
  operatingTotal,
  spansYears,
} from '@/lib/inventory/cogs-view';
import { accountsForCategory } from '@/lib/inventory/category-accounts';
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
 * Two variants:
 *  - `compact` (default) — what the close panel shows beneath a single
 *    location's journal entry.
 *  - `full` — adds the QB COGS account each category lands in and a trailing
 *    operating-total column, for the FIFO page's COGS tab where the grid is the
 *    whole point rather than a footnote.
 */
export default function CategoryCogsByMonth({
  rows,
  location,
  firstAnchoredMonth,
  darkMode,
  subText,
  border,
  variant = 'compact',
}: {
  rows: CategoryCogsSeriesRow[];
  location: string;
  firstAnchoredMonth: string | null;
  darkMode: boolean;
  subText: string;
  border: string;
  variant?: 'compact' | 'full';
}) {
  const grid = buildCogsGrid(rows, { location, firstAnchoredMonth });
  if (grid.months.length === 0) return null;

  const full = variant === 'full';
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
              {full && <th className={th}>QuickBooks COGS account</th>}
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
              {full && (
                <th
                  className={`${th} text-right whitespace-nowrap`}
                  title="The months above, less the cutover and true-up months"
                >
                  Operating total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {grid.categories.map((c) => {
              // Uncoded and Opening Balance are our own buckets, not chart-of-accounts
              // categories: they land on the parent account, flagged as a residual.
              const { cogs: account, mapped } = accountsForCategory(c);
              return (
                <tr key={c} className={`border-b last:border-0 ${border}`}>
                  <td className="px-2 py-1 font-medium">{c}</td>
                  {full && (
                    <td className={`px-2 py-1 ${mapped ? '' : subText}`}>
                      {account}
                      {!mapped && (
                        <span
                          title="No dedicated QuickBooks account — this bucket posts to the parent Cost of Goods Sold line as a residual."
                          className="ml-1 text-[9px] px-1 rounded bg-slate-500/20 font-semibold uppercase cursor-help"
                        >
                          residual
                        </span>
                      )}
                    </td>
                  )}
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
                  {full && (
                    <td className={`${cell} font-medium`}>
                      {usd.format(categoryOperatingTotal(grid, c))}
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className={`border-t-2 font-semibold ${border}`}>
              <td className="px-2 py-1">Operating COGS</td>
              {full && <td className={`px-2 py-1 ${subText}`}>Cost of Goods Sold (5000.xx)</td>}
              {grid.months.map((m) => (
                <td key={m} className={`${cell} ${isExcludedMonth(grid, m) ? subText : ''}`}>
                  {isExcludedMonth(grid, m) ? '—' : usd.format(monthTotal(grid, m))}
                </td>
              ))}
              {full && <td className={cell}>{usd.format(operatingTotal(grid))}</td>}
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
