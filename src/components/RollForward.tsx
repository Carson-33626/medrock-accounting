'use client';

import HelpTip from './HelpTip';
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
  const th = `px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider ${subText}`;

  if (rows.length === 0) {
    return (
      <div className={`rounded-xl shadow-sm p-6 ${cardBg} border ${border} text-center text-sm ${subText}`}>
        No roll-forward data for this month.
      </div>
    );
  }

  const cell = (value: number | null): string => (value === null ? '—' : usd.format(value));

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-3`}>
      <div>
        <p className={`text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 ${subText}`}>
          Roll-forward
          <HelpTip
            label="How the roll-forward works"
            text="Beginning inventory, plus purchases received during the month, minus ending inventory = cost of goods consumed. Deriving COGS this way means the roll-forward always ties to the balance-sheet change — it never disagrees with the inventory values above."
          />
        </p>
        <p className="text-sm font-medium mt-1">
          COGS is derived: Beginning + Purchases − Ending. It ties to the balance sheet by construction.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${border}`}>
              <th className={`${th} text-left`}>Location</th>
              <th className={`${th} text-right`}>Beginning</th>
              <th className={`${th} text-right`}>Purchases</th>
              <th className={`${th} text-right`}>COGS (derived)</th>
              <th className={`${th} text-right`}>Ending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isTotal = r.cut === 'total';
              return (
                <tr
                  key={r.label}
                  className={`border-b last:border-0 ${border} ${isTotal ? 'border-t font-semibold' : ''}`}
                >
                  <td className="px-2 py-1">
                    {r.label.replace('MedRock ', '')}
                    {r.windowStart && !isTotal && (
                      <span className={`ml-2 text-xs font-normal ${subText}`}>window start</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{cell(r.beginning)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{cell(r.purchases)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{cell(r.cogs)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{cell(r.ending)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!purchasesAvailable && (
        <p className={`text-xs ${subText}`}>
          Purchases data pending next data-loader run — COGS cannot be derived yet. Beginning and Ending
          are shown; the roll-forward completes once the loader writes the purchases columns.
        </p>
      )}
    </div>
  );
}
