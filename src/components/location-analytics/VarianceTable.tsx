'use client';

import { usd0 } from './chartTheme';
import type { VarianceGroup, VarianceRow, VarianceStatus } from '@/lib/forecast/manual-forecast-variance';

function statusBadgeClass(status: VarianceStatus, darkMode: boolean): string {
  switch (status) {
    case 'close':
      return darkMode ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700';
    case 'over':
      return darkMode ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700';
    case 'under':
      return darkMode ? 'bg-red-500/20 text-red-300' : 'bg-red-100 text-red-700';
    default:
      return darkMode ? 'bg-slate-500/20 text-slate-300' : 'bg-slate-200 text-slate-600';
  }
}

function statusLabel(status: VarianceStatus): string {
  switch (status) {
    case 'close':
      return 'Close';
    case 'over':
      return 'Over';
    case 'under':
      return 'Under';
    default:
      return '—';
  }
}

function StatusBadge({ status, darkMode }: { status: VarianceStatus; darkMode: boolean }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${statusBadgeClass(status, darkMode)}`}>
      {statusLabel(status)}
    </span>
  );
}

function Money({ value }: { value: number }) {
  return <span className={value < 0 ? 'text-red-500' : undefined}>{usd0.format(value)}</span>;
}

function SystemCell({ value, kind }: { value: number | null; kind: 'actual' | 'projected' | null }) {
  if (value === null) return <span className="text-slate-400 italic">—</span>;
  return (
    <span>
      <Money value={value} />
      {kind && <span className="ml-1 text-[9px] uppercase text-slate-400">{kind === 'actual' ? 'act' : 'proj'}</span>}
    </span>
  );
}

function DeltaCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400 italic">—</span>;
  return <Money value={value} />;
}

function DeltaPctCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400 italic">—</span>;
  return (
    <span className={value >= 0 ? 'text-emerald-500' : 'text-red-500'}>
      {value >= 0 ? '+' : ''}
      {value.toFixed(1)}%
    </span>
  );
}

/**
 * Manual-vs-system variance table, grouped by location with a subtotal row.
 * Rendered by `ForecastPanel` only when a manual overlay is selected — see
 * `computeVariance` (@/lib/forecast/manual-forecast-variance) for the row math.
 * Styling mirrors `ForecastTable` (card, sticky head, usd0, theme props).
 */
export function VarianceTable({
  groups,
  darkMode,
  cardBg,
  subText,
  rowBorder,
  metricLabel,
}: {
  groups: VarianceGroup[];
  darkMode: boolean;
  cardBg: string;
  subText: string;
  rowBorder: string;
  metricLabel: string;
}) {
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const groupHead = darkMode ? 'bg-slate-800/60' : 'bg-slate-50';
  const subtotalRow = darkMode ? 'bg-slate-700/30' : 'bg-slate-50';

  const renderRow = (row: VarianceRow) => (
    <tr key={`${row.location}-${row.sortKey}`} className={`border-t ${rowBorder}`}>
      <td className="px-3 py-2 text-left">{row.label}</td>
      <td className="px-3 py-2 text-right">
        <Money value={row.manual} />
      </td>
      <td className="px-3 py-2 text-right">
        <SystemCell value={row.system} kind={row.systemKind} />
      </td>
      <td className="px-3 py-2 text-right">
        <DeltaCell value={row.delta} />
      </td>
      <td className="px-3 py-2 text-right">
        <DeltaPctCell value={row.deltaPct} />
      </td>
      <td className="px-3 py-2 text-right">
        <StatusBadge status={row.status} darkMode={darkMode} />
      </td>
    </tr>
  );

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`p-4 border-b ${rowBorder}`}>
        <p className="text-sm font-semibold">{metricLabel} — manual vs. system variance</p>
        <p className={`text-xs ${subText}`}>
          Manual overlay compared against actuals (completed months) or the system projection (future months). Δ%
          within ±10% is Close.
        </p>
      </div>
      {groups.length === 0 ? (
        <div className={`p-8 text-center text-sm ${subText}`}>
          The selected manual overlay has no entries for a location in this forecast.
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={tableHead}>
                <th className="px-3 py-2 text-left font-medium">Month</th>
                <th className="px-3 py-2 text-right font-medium">Manual</th>
                <th className="px-3 py-2 text-right font-medium">System</th>
                <th className="px-3 py-2 text-right font-medium">Δ</th>
                <th className="px-3 py-2 text-right font-medium">Δ%</th>
                <th className="px-3 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) => [
                <tr key={`${group.location}-header`} className={groupHead}>
                  <td colSpan={6} className="px-3 py-1.5 text-left font-semibold">
                    {group.label}
                  </td>
                </tr>,
                ...group.rows.map(renderRow),
                <tr key={`${group.location}-subtotal`} className={`border-t-2 ${rowBorder} ${subtotalRow} font-medium`}>
                  <td className="px-3 py-2 text-left">Subtotal</td>
                  <td className="px-3 py-2 text-right">
                    <Money value={group.subtotal.manual} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <SystemCell value={group.subtotal.system} kind={null} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <DeltaCell value={group.subtotal.delta} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <DeltaPctCell value={group.subtotal.deltaPct} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <StatusBadge status={group.subtotal.status} darkMode={darkMode} />
                  </td>
                </tr>,
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
