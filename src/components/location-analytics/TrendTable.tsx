'use client';

import type { LocationTrendSeries } from '@/types/location-analytics';
import { usd0, type TrendRow } from './chartTheme';

function num(value: string | number | undefined): number {
  return typeof value === 'number' ? value : 0;
}

/** Cell value, colored red when negative (helps net income scan). */
function Money({ value }: { value: number }) {
  return <span className={value < 0 ? 'text-red-500' : undefined}>{usd0.format(value)}</span>;
}

/**
 * The numbers behind the trend charts — one row per month, a column per
 * location plus a Total, for the metric chosen in TrendsPanel.
 */
export function TrendTable({
  rows,
  series,
  metricLabel,
  darkMode,
  cardBg,
  subText,
  rowBorder,
}: {
  rows: TrendRow[];
  series: LocationTrendSeries[];
  metricLabel: string;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
}) {
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';

  const colTotals = series.map((s) => rows.reduce((sum, r) => sum + num(r[s.label]), 0));
  const grandTotal = colTotals.reduce((a, b) => a + b, 0);

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`p-4 border-b ${rowBorder}`}>
        <p className="text-sm font-semibold">{metricLabel} by month</p>
        <p className={`text-xs ${subText}`}>Monthly values per location for inspection</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={tableHead}>
              <th className="px-3 py-2 text-left font-medium">Month</th>
              {series.map((s) => (
                <th key={s.qbLocation} className="px-3 py-2 text-right font-medium">
                  {s.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rowTotal = series.reduce((sum, s) => sum + num(r[s.label]), 0);
              return (
                <tr
                  key={r.month}
                  className={`border-t ${rowBorder} ${darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-3 py-2 whitespace-nowrap font-medium">{r.month}</td>
                  {series.map((s) => (
                    <td key={s.qbLocation} className="px-3 py-2 text-right">
                      <Money value={num(r[s.label])} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-medium">
                    <Money value={rowTotal} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={`border-t-2 ${rowBorder} font-bold`}>
              <td className="px-3 py-2">TOTAL</td>
              {colTotals.map((t, i) => (
                <td key={series[i].qbLocation} className="px-3 py-2 text-right">
                  <Money value={t} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Money value={grandTotal} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
