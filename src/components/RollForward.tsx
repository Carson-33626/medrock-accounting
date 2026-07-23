'use client';

import type { RollForwardRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Roll-forward table: Beginning + Purchases − Ending = COGS (derived), per location + total. */
export default function RollForward({
  rows,
  purchasesAvailable,
  darkMode,
}: {
  rows: RollForwardRow[];
  purchasesAvailable: boolean;
  darkMode: boolean;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  if (rows.length === 0) {
    return (
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <p className={`text-sm ${subText}`}>No roll-forward data for this month.</p>
      </div>
    );
  }

  const cell = (value: number | null): string => (value === null ? '—' : usd.format(value));

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold mb-1">Roll-forward</p>
      <p className={`text-xs mb-3 ${subText}`}>
        COGS is derived: Beginning + Purchases − Ending. It ties to the balance sheet by construction.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`text-xs uppercase tracking-wider ${subText}`}>
              <th className="py-2 text-left font-semibold">Location</th>
              <th className="py-2 text-right font-semibold">Beginning</th>
              <th className="py-2 text-right font-semibold">Purchases</th>
              <th className="py-2 text-right font-semibold">COGS (derived)</th>
              <th className="py-2 text-right font-semibold">Ending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isTotal = r.cut === 'total';
              return (
                <tr
                  key={r.label}
                  className={`border-t ${border} ${isTotal ? 'font-semibold' : ''}`}
                  style={isTotal ? { borderTopWidth: 2 } : undefined}
                >
                  <td className="py-2">
                    {r.label.replace('MedRock ', '')}
                    {r.windowStart && !isTotal && (
                      <span className={`ml-2 text-xs font-normal ${subText}`}>window start</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{cell(r.beginning)}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.purchases)}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.cogs)}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.ending)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!purchasesAvailable && (
        <p className={`text-xs mt-3 ${subText}`}>
          Purchases data pending next data-loader run — COGS cannot be derived yet. Beginning and Ending
          are shown; the roll-forward completes once the loader writes the purchases columns.
        </p>
      )}
    </div>
  );
}
