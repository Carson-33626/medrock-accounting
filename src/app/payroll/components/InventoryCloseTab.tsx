'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from '@/components/Explainer';
import HelpTip from '@/components/HelpTip';
import RollForward from '@/components/RollForward';
import JournalEntryPanel from '@/components/JournalEntryPanel';
import { monthDates } from '@/lib/inventory/month-dates';
import type {
  CloseBasis,
  MonthlyCloseResponse,
  RollbackResponse,
  RollbackValuationRow,
} from '@/types/inventory';

/**
 * Inventory month-end close: roll-forward + suggested adjusting JE for a chosen
 * month, on the rollback dual-basis valuation. Ported from /inventory/as-of —
 * the close lives here with the other journal entries; the as-of page keeps the
 * point-in-time value only.
 */
export function InventoryCloseTab() {
  const { darkMode } = useDarkMode();
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [closeBasis, setCloseBasis] = useState<CloseBasis>('floor');
  const [monthlyClose, setMonthlyClose] = useState<MonthlyCloseResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/rollback')
      .then((r) => r.json() as Promise<RollbackResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rows' in data) setRollbackRows(data.rows);
      })
      .catch(() => {
        // Non-fatal: the tab renders its empty state.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Newest first — the close is almost always run for the most recent month.
  const months = useMemo(() => {
    const set = new Set(rollbackRows.map((r) => r.as_of_month));
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rollbackRows]);

  const selectedMonth = month ?? months[0] ?? null;

  useEffect(() => {
    if (!selectedMonth) return;
    let cancelled = false;
    fetch(`/api/inventory/monthly-close?month=${encodeURIComponent(selectedMonth)}&basis=${closeBasis}`)
      .then((r) => r.json() as Promise<MonthlyCloseResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rollForward' in data) setMonthlyClose(data);
      })
      .catch(() => {
        // Non-fatal: the section keeps its loading state.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMonth, closeBasis]);

  const closeReady =
    monthlyClose && monthlyClose.month === selectedMonth && monthlyClose.basis === closeBasis;
  const dates = selectedMonth ? monthDates(selectedMonth) : null;

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  if (loaded && months.length === 0) {
    return (
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <p className={`text-sm ${subText}`}>
          No reconstructed month-end valuations yet — the close appears once the Data Loader ships
          rollback rows.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Explainer id="inventory-close-je" title="What am I looking at?">
        <p>
          The inventory month-end close: what FIFO inventory was worth at the end of the chosen month,
          rolled forward as Beginning + Purchases − Ending = cost of goods consumed, and the adjusting
          entry that brings the QuickBooks inventory-asset balance to the FIFO figure.
        </p>
        <p>
          <strong>Floor vs. full-coverage:</strong> the receipt-priced floor counts only stock traceable
          to a priced purchase receipt (conservative); the full-coverage estimate counts everything on
          LifeFile&rsquo;s lot report, with estimated prices where a receipt is missing. Accounting picks
          which basis becomes official; the point-in-time values behind both live on the{' '}
          <a href="/inventory/as-of" className="underline">
            As-of Value
          </a>{' '}
          page.
        </p>
        <p>
          The entry is a suggestion for the CPA — it restates the inventory asset and is never posted
          automatically.
        </p>
      </Explainer>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <label className={`text-sm ${subText}`}>Close for</label>
        <select value={selectedMonth ?? ''} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
          {months.map((m) => (
            <option key={m} value={m}>
              {m} (close {monthDates(m).asOf})
            </option>
          ))}
        </select>
        <HelpTip
          label="Floor vs. full-coverage"
          text="Which ending value the roll-forward and journal entry are built from: the conservative receipt-priced floor, or the full-coverage estimate that includes estimated prices for stock without a matching receipt."
        />
        <div className={`inline-flex rounded-lg border overflow-hidden ${border}`}>
          <button
            onClick={() => setCloseBasis('floor')}
            className={`px-3 py-2 text-sm font-medium ${closeBasis === 'floor' ? 'text-white' : subText}`}
            style={closeBasis === 'floor' ? { backgroundColor: '#5e3b8d' } : undefined}
          >
            Receipt-priced floor
          </button>
          <button
            onClick={() => setCloseBasis('full')}
            className={`px-3 py-2 text-sm font-medium ${closeBasis === 'full' ? 'text-white' : subText}`}
            style={closeBasis === 'full' ? { backgroundColor: '#5e3b8d' } : undefined}
          >
            Full-coverage estimate
          </button>
        </div>
        {selectedMonth && (
          <a
            href={`/api/inventory/monthly-close?month=${encodeURIComponent(selectedMonth)}&basis=${closeBasis}&format=xlsx`}
            className={`ml-auto px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}
          >
            Excel (close package)
          </a>
        )}
      </div>

      {dates && (
        <p className={`text-sm ${subText}`}>
          Roll-forward and FIFO target vs. the QuickBooks book balance as of <strong>{dates.asOf}</strong>.
        </p>
      )}

      {closeReady && monthlyClose ? (
        <>
          <RollForward
            rows={monthlyClose.rollForward}
            purchasesAvailable={monthlyClose.purchasesAvailable}
            darkMode={darkMode}
          />
          <JournalEntryPanel
            journalEntries={monthlyClose.journalEntries}
            basis={monthlyClose.basis}
            monthEnd={monthlyClose.monthEnd}
            darkMode={darkMode}
          />
        </>
      ) : (
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <p className={`text-sm ${subText}`}>Loading monthly close…</p>
        </div>
      )}
    </div>
  );
}
