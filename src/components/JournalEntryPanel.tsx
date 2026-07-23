'use client';

import type { CloseBasis, LocationJE } from '@/types/inventory';
import { journalEntryLines } from '@/lib/inventory/monthly-close';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * Suggested adjusting JE per location: FIFO target (selected basis Ending) vs.
 * the QB inventory-asset book balance. Copy-friendly. Nothing is posted to QB.
 */
export default function JournalEntryPanel({
  journalEntries,
  basis,
  monthEnd,
  darkMode,
}: {
  journalEntries: LocationJE[];
  basis: CloseBasis;
  monthEnd: string;
  darkMode: boolean;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const innerBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-sm font-semibold">Suggested adjusting journal entry</p>
        <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
          Suggested only — nothing is posted to QuickBooks
        </span>
      </div>
      <p className={`text-xs mb-4 ${subText}`}>
        Adjustment = FIFO target (Ending, {basis === 'floor' ? 'receipt-priced floor' : 'full-coverage estimate'}) −
        QuickBooks inventory-asset book balance, per location as of {monthEnd}.
      </p>

      <div className="space-y-4">
        {journalEntries.map((je) => {
          const name = je.location.replace('MedRock ', '');
          if (!je.bookAvailable) {
            return (
              <div key={je.location} className={`rounded-lg border ${border} p-4`}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{name}</p>
                  <span className="text-xs px-2 py-1 rounded border bg-red-50 text-red-700 border-red-200 font-semibold">
                    book balance unavailable — reconnect QuickBooks
                  </span>
                </div>
                <p className={`text-xs mt-2 ${subText}`}>
                  FIFO target {usd.format(je.fifoTarget)}. Reconnect the QuickBooks realm to compute the adjustment.
                </p>
              </div>
            );
          }

          const lines = journalEntryLines(je, basis, monthEnd);
          return (
            <div key={je.location} className={`rounded-lg border ${border} p-4`}>
              <p className="text-sm font-semibold mb-3">{name}</p>

              <div className="grid grid-cols-3 gap-3 mb-3 text-sm">
                <div>
                  <p className={`text-xs ${subText}`}>FIFO target</p>
                  <p className="tabular-nums font-medium">{usd.format(je.fifoTarget)}</p>
                </div>
                <div>
                  <p className={`text-xs ${subText}`}>QB book balance</p>
                  <p className="tabular-nums font-medium">{usd.format(je.qbBookBalance ?? 0)}</p>
                </div>
                <div>
                  <p className={`text-xs ${subText}`}>Adjustment</p>
                  <p className="tabular-nums font-medium" style={{ color: '#5e3b8d' }}>
                    {usd.format(je.adjustment ?? 0)}
                  </p>
                </div>
              </div>

              {lines.length === 0 ? (
                <p className={`text-xs ${subText}`}>No adjustment needed — FIFO ties to the book balance.</p>
              ) : (
                <table className={`w-full text-sm rounded-lg overflow-hidden ${innerBg}`}>
                  <thead>
                    <tr className={`text-xs uppercase tracking-wider ${subText}`}>
                      <th className="py-2 px-3 text-left font-semibold">Account</th>
                      <th className="py-2 px-3 text-right font-semibold">Debit</th>
                      <th className="py-2 px-3 text-right font-semibold">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={`${line.account}-${idx}`} className={`border-t ${border}`}>
                        <td className="py-2 px-3">{line.account}</td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {line.debit === null ? '' : usd.format(line.debit)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {line.credit === null ? '' : usd.format(line.credit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {lines.length > 0 && <p className={`text-xs mt-2 ${subText}`}>Memo: {lines[0].memo}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
