'use client';

import { useMemo, useState } from 'react';
import { usd0 } from './chartTheme';
import type { ForecastLocation, ForecastModel } from './forecastModel';

type CellKind = 'actual' | 'dual' | 'projected' | 'empty';
interface CellView {
  kind: CellKind;
  value: number;
  estValue: number | null;
}

function cellFor(loc: ForecastLocation, month: string, model: ForecastModel): CellView {
  if (month !== model.currentMonthKey && month in loc.actual) {
    return { kind: 'actual', value: loc.actual[month], estValue: null };
  }
  if (month === model.currentMonthKey) {
    return { kind: 'dual', value: loc.actual[month] ?? 0, estValue: loc.estCurrent };
  }
  if (month in loc.future) {
    return { kind: 'projected', value: loc.future[month], estValue: null };
  }
  return { kind: 'empty', value: 0, estValue: null };
}

function sortValue(cell: CellView): number {
  if (cell.kind === 'empty') return Number.NEGATIVE_INFINITY;
  if (cell.kind === 'dual') return cell.estValue ?? cell.value;
  return cell.value;
}

function Money({ value, muted }: { value: number; muted?: boolean }) {
  const cls = value < 0 ? 'text-red-500' : muted ? 'text-slate-400 italic' : undefined;
  return <span className={cls}>{usd0.format(value)}</span>;
}

export function ForecastTable({
  model,
  darkMode,
  cardBg,
  subText,
  rowBorder,
  metricLabel,
}: {
  model: ForecastModel;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
  metricLabel: string;
}) {
  const [sortKey, setSortKey] = useState<string>('location');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const stickyBg = darkMode ? 'bg-slate-800' : 'bg-white';
  const projColHead = darkMode ? 'bg-slate-700/60' : 'bg-amber-50';
  const projCell = darkMode ? 'bg-slate-700/30' : 'bg-slate-50';
  const dualCell = darkMode ? 'bg-amber-500/10' : 'bg-amber-50';

  const isProjectedCol = (month: string): boolean =>
    month === model.currentMonthKey || model.futureMonths.includes(month);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedLocations = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const rows = [...model.locations];
    rows.sort((a, b) => {
      if (sortKey === 'location') return a.label < b.label ? -dir : a.label > b.label ? dir : 0;
      if (sortKey === 'method') return a.method < b.method ? -dir : a.method > b.method ? dir : 0;
      if (sortKey === 'cmgr') return (a.cmgr - b.cmgr) * dir;
      // month column
      return (sortValue(cellFor(a, sortKey, model)) - sortValue(cellFor(b, sortKey, model))) * dir;
    });
    return rows;
  }, [model, sortKey, sortDir]);

  // TOTAL row per month
  const totals = useMemo(() => {
    return model.allMonths.map((month) => {
      let actualSum = 0;
      let estSum = 0;
      let projSum = 0;
      let kind: CellKind = 'empty';
      for (const loc of model.locations) {
        const c = cellFor(loc, month, model);
        if (c.kind === 'actual') {
          actualSum += c.value;
          kind = 'actual';
        } else if (c.kind === 'dual') {
          actualSum += c.value;
          estSum += c.estValue ?? 0;
          kind = 'dual';
        } else if (c.kind === 'projected') {
          projSum += c.value;
          kind = 'projected';
        }
      }
      return { month, kind, actualSum, estSum, projSum };
    });
  }, [model]);

  const arrow = (key: string) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`p-4 border-b ${rowBorder}`}>
        <p className="text-sm font-semibold">{metricLabel} — actuals &amp; forecast by month</p>
        <p className={`text-xs ${subText}`}>
          Plain = actual · shaded = projected · the current month shows actual-to-date with an estimate. Click a
          header to sort.
        </p>
      </div>
      <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className={tableHead}>
              <th
                className={`sticky left-0 z-10 ${tableHead} px-3 py-2 text-left font-medium cursor-pointer`}
                onClick={() => handleSort('location')}
              >
                Location{arrow('location')}
              </th>
              {model.allMonths.map((month) => (
                <th
                  key={month}
                  className={`px-3 py-2 text-right font-medium cursor-pointer ${isProjectedCol(month) ? projColHead : ''}`}
                  onClick={() => handleSort(month)}
                >
                  {month}
                  {arrow(month)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium cursor-pointer" onClick={() => handleSort('method')}>
                Method{arrow('method')}
              </th>
              <th className="px-3 py-2 text-right font-medium cursor-pointer" onClick={() => handleSort('cmgr')}>
                CMGR{arrow('cmgr')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedLocations.map((loc) => (
              <tr key={loc.qbLocation} className={`border-t ${rowBorder}`}>
                <td className={`sticky left-0 z-10 ${stickyBg} px-3 py-2 text-left font-medium`}>
                  {loc.label}
                  {!loc.connected && <span className={`ml-2 text-[10px] uppercase ${subText}`}>n/c</span>}
                </td>
                {model.allMonths.map((month) => {
                  const c = cellFor(loc, month, model);
                  if (c.kind === 'empty') return <td key={month} className="px-3 py-2 text-right" />;
                  if (c.kind === 'dual') {
                    return (
                      <td key={month} className={`px-3 py-2 text-right ${dualCell}`}>
                        <span className="block font-medium">
                          <Money value={c.value} />
                        </span>
                        <span className="block text-[10px] text-slate-400 italic">
                          est. {usd0.format(c.estValue ?? 0)}
                        </span>
                      </td>
                    );
                  }
                  if (c.kind === 'projected') {
                    return (
                      <td key={month} className={`px-3 py-2 text-right ${projCell}`}>
                        <Money value={c.value} muted />
                      </td>
                    );
                  }
                  return (
                    <td key={month} className="px-3 py-2 text-right">
                      <Money value={c.value} />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${methodBadge(loc.method, darkMode)}`}>
                    {loc.method}
                  </span>
                </td>
                <td
                  className={`px-3 py-2 text-right font-medium ${loc.cmgr >= 0 ? 'text-emerald-500' : 'text-red-500'}`}
                >
                  {loc.cmgr >= 0 ? '+' : ''}
                  {loc.cmgr.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={`border-t-2 ${rowBorder} font-bold`}>
              <td className={`sticky left-0 z-10 ${stickyBg} px-3 py-2 text-left`}>TOTAL</td>
              {totals.map((t) => {
                if (t.kind === 'empty') return <td key={t.month} className="px-3 py-2 text-right" />;
                if (t.kind === 'dual') {
                  return (
                    <td key={t.month} className={`px-3 py-2 text-right ${dualCell}`}>
                      <span className="block">
                        <Money value={t.actualSum} />
                      </span>
                      <span className="block text-[10px] text-slate-400 italic">est. {usd0.format(t.estSum)}</span>
                    </td>
                  );
                }
                if (t.kind === 'projected') {
                  return (
                    <td key={t.month} className={`px-3 py-2 text-right ${projCell}`}>
                      <Money value={t.projSum} muted />
                    </td>
                  );
                }
                return (
                  <td key={t.month} className="px-3 py-2 text-right">
                    <Money value={t.actualSum} />
                  </td>
                );
              })}
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function methodBadge(method: string, darkMode: boolean): string {
  if (method === 'Holt-Winters') return darkMode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700';
  if (method === 'Damped trend') return darkMode ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700';
  return darkMode ? 'bg-slate-500/20 text-slate-300' : 'bg-slate-200 text-slate-600';
}
