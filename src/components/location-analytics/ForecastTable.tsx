'use client';

import { useMemo } from 'react';
import { usd0 } from './chartTheme';
import type { ForecastLocation, ForecastModel } from './forecastModel';

type CellKind = 'actual' | 'dual' | 'projected' | 'empty';
interface CellView {
  kind: CellKind;
  value: number;
  estValue: number | null;
}

function cellFor(loc: ForecastLocation, month: string, model: ForecastModel): CellView {
  if (model.provisionalMonths.includes(month)) {
    return { kind: 'dual', value: loc.actual[month] ?? 0, estValue: loc.est[month] ?? 0 };
  }
  if (month in loc.future) {
    return { kind: 'projected', value: loc.future[month], estValue: null };
  }
  if (month in loc.actual) {
    return { kind: 'actual', value: loc.actual[month], estValue: null };
  }
  return { kind: 'empty', value: 0, estValue: null };
}

function Money({ value, muted }: { value: number; muted?: boolean }) {
  const cls = value < 0 ? 'text-red-500' : muted ? 'text-slate-400 italic' : undefined;
  return <span className={cls}>{usd0.format(value)}</span>;
}

function Cmgr({ value }: { value: number }) {
  return (
    <span className={value >= 0 ? 'text-emerald-500 font-semibold' : 'text-red-500 font-semibold'}>
      {value >= 0 ? '+' : ''}
      {value.toFixed(1)}%
    </span>
  );
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${year}`;
}
function isPreOpening(openedMonth: string | null, month: string): boolean {
  return !!openedMonth && month < openedMonth;
}

function methodBadge(method: string, darkMode: boolean): string {
  if (method === 'Holt-Winters') return darkMode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700';
  if (method === 'Damped trend') return darkMode ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-100 text-blue-700';
  return darkMode ? 'bg-slate-500/20 text-slate-300' : 'bg-slate-200 text-slate-600';
}

/** CMGR (%) from last-actual to final-forecast for an arbitrary summed series. */
function cmgrFrom(lastActual: number, finalForecast: number, horizon: number): number {
  if (horizon <= 0 || lastActual <= 0 || finalForecast <= 0) return 0;
  return (Math.pow(finalForecast / lastActual, 1 / horizon) - 1) * 100;
}

/**
 * Transposed forecast table: months as rows (latest first), locations as
 * columns + a Total column. CMGR is the first row; per-location forecast method
 * is shown as a highlight strip above the table. Current month is a dual
 * actual + estimate cell; future months are shaded.
 */
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
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const stickyBg = darkMode ? 'bg-slate-800' : 'bg-white';
  const projRow = darkMode ? 'bg-slate-700/30' : 'bg-slate-50';
  const dualRow = darkMode ? 'bg-amber-500/10' : 'bg-amber-50';

  const monthsDesc = useMemo(() => [...model.allMonths].reverse(), [model]);
  const isProvisional = (month: string): boolean => model.provisionalMonths.includes(month);
  const isFuture = (month: string): boolean => model.futureMonths.includes(month);

  // Total column: CMGR from the summed series, anchored on the last fully-closed month.
  const totalCmgr = useMemo(() => {
    const trained = model.completedMonths.filter((m) => !model.provisionalMonths.includes(m));
    const lastActualMonth = trained[trained.length - 1];
    const lastFutureMonth = model.futureMonths[model.futureMonths.length - 1];
    if (!lastActualMonth || !lastFutureMonth) return 0;
    const lastActual = model.locations.reduce((s, l) => s + (l.actual[lastActualMonth] ?? 0), 0);
    const finalForecast = model.locations.reduce((s, l) => s + (l.future[lastFutureMonth] ?? 0), 0);
    const periods = model.provisionalMonths.length + model.futureMonths.length;
    return cmgrFrom(lastActual, finalForecast, periods);
  }, [model]);

  // Aggregate one month across locations for the Total column.
  const totalCell = (month: string): CellView => {
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
    if (kind === 'dual') return { kind, value: actualSum, estValue: estSum };
    if (kind === 'projected') return { kind, value: projSum, estValue: null };
    return { kind, value: actualSum, estValue: null };
  };

  const renderCell = (c: CellView, keyId: string) => {
    if (c.kind === 'empty') return <td key={keyId} className="px-3 py-2 text-right" />;
    if (c.kind === 'dual') {
      return (
        <td key={keyId} className="px-3 py-2 text-right">
          <span className="block font-medium">
            <Money value={c.value} />
          </span>
          <span className="block text-[10px] text-slate-400 italic">est. {usd0.format(c.estValue ?? 0)}</span>
        </td>
      );
    }
    return (
      <td key={keyId} className="px-3 py-2 text-right">
        <Money value={c.value} muted={c.kind === 'projected'} />
      </td>
    );
  };

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`p-4 border-b ${rowBorder}`}>
        <p className="text-sm font-semibold">{metricLabel} — actuals &amp; forecast by month</p>
        <p className={`text-xs ${subText}`}>
          Latest month first · plain = actual · shaded = projected · the current month shows actual-to-date with
          an estimate.
        </p>
        {/* Forecast-method highlight strip */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`text-xs uppercase tracking-wide ${subText}`}>Forecast method</span>
          {model.locations.map((loc) => (
            <span key={loc.qbLocation} className="text-[11px] flex items-center gap-1">
              <span className={subText}>{loc.label}:</span>
              <span className={`px-2 py-0.5 rounded-full ${methodBadge(loc.method, darkMode)}`}>{loc.method}</span>
            </span>
          ))}
        </div>
        {model.locations
          .filter((loc) => loc.openedMonth)
          .map((loc) => (
            <p key={loc.qbLocation} className={`mt-2 text-[11px] ${subText}`}>
              ↳ <strong>{loc.label}</strong> opened {fmtMonth(loc.openedMonth as string)} — earlier months are
              <span className="italic"> pre-opening expenses</span> and are excluded from its forecast.
            </p>
          ))}
      </div>
      <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className={tableHead}>
              <th className={`sticky left-0 z-10 ${tableHead} px-3 py-2 text-left font-medium`}>Month</th>
              {model.locations.map((loc) => (
                <th key={loc.qbLocation} className="px-3 py-2 text-right font-medium">
                  {loc.label}
                  {!loc.connected && <span className={`ml-1 text-[10px] uppercase ${subText}`}>n/c</span>}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {/* CMGR — first row */}
            <tr className={`border-b-2 ${rowBorder} font-medium`}>
              <td className={`sticky left-0 z-10 ${tableHead} px-3 py-2 text-left`}>CMGR</td>
              {model.locations.map((loc) => (
                <td key={loc.qbLocation} className="px-3 py-2 text-right">
                  <Cmgr value={loc.cmgr} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Cmgr value={totalCmgr} />
              </td>
            </tr>
            {/* Month rows, latest first */}
            {monthsDesc.map((month) => {
              const rowBg = isProvisional(month) ? dualRow : isFuture(month) ? projRow : '';
              const tag = isProvisional(month) ? 'prov' : isFuture(month) ? 'proj' : '';
              return (
                <tr key={month} className={`border-t ${rowBorder} ${rowBg}`}>
                  <td className={`sticky left-0 z-10 ${rowBg || stickyBg} px-3 py-2 text-left font-medium`}>
                    {month}
                    {tag && <span className={`ml-2 text-[9px] uppercase ${subText}`}>{tag}</span>}
                  </td>
                  {model.locations.map((loc) => {
                    const keyId = `${loc.qbLocation}-${month}`;
                    if (isPreOpening(loc.openedMonth, month)) {
                      const c = cellFor(loc, month, model);
                      return (
                        <td key={keyId} className="px-3 py-2 text-right" title="Pre-opening — excluded from forecast">
                          <span className="block text-slate-400 italic">{usd0.format(c.value)}</span>
                          <span className="block text-[9px] uppercase text-slate-400">pre-open</span>
                        </td>
                      );
                    }
                    return renderCell(cellFor(loc, month, model), keyId);
                  })}
                  {renderCell(totalCell(month), `total-${month}`)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
