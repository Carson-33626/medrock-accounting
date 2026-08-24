'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from './Explainer';
import { monthDates } from '@/lib/inventory/month-dates';
import type {
  Basis,
  RollbackResponse,
  RollbackValuationRow,
  SummaryResponse,
  ValuationSummaryRow,
} from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const qty0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export default function InventorySnapshot() {
  const { darkMode } = useDarkMode();
  const [basis, setBasis] = useState<Basis>('accrual');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);

  // Backward-rollback reconstruction (accrual-only). The table may not exist
  // yet — the route returns { rows: [] } in that case, so the page behaves
  // exactly as today until the loader phase lands. Fetch once; it is not
  // basis-dependent.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/rollback')
      .then((r) => r.json() as Promise<RollbackResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rows' in data) setRollbackRows(data.rows);
      })
      .catch(() => {
        // Non-fatal: absence of rollback data leaves the page in its prior single-headline state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/inventory/summary?basis=${basis}&location=all`)
      .then((r) => r.json() as Promise<SummaryResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) {
          setError(data.error);
        } else {
          setSummary(data);
          setError(null);
          setMonth((prev) => prev ?? data.latestMonth);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [basis]);

  const selectedMonth = month ?? summary?.latestMonth ?? null;
  const monthRows = useMemo<ValuationSummaryRow[]>(
    () => (summary && selectedMonth ? summary.rows.filter((r) => r.as_of_month === selectedMonth) : []),
    [summary, selectedMonth],
  );

  const view = useMemo(() => {
    const total = monthRows.reduce((s, r) => s + r.on_hand_value_fifo, 0);
    const ob = monthRows.reduce((s, r) => s + r.opening_balance_value, 0);
    const byLocation = new Map<string, number>();
    const byCategory = new Map<string, number>();
    for (const r of monthRows) {
      byLocation.set(r.location, (byLocation.get(r.location) ?? 0) + r.on_hand_value_fifo);
      byCategory.set(r.qb_category, (byCategory.get(r.qb_category) ?? 0) + r.on_hand_value_fifo);
    }
    return { total, ob, byLocation, byCategory };
  }, [monthRows]);

  const rollbackForMonth = useMemo<RollbackValuationRow[]>(
    () => (selectedMonth ? rollbackRows.filter((r) => r.as_of_month === selectedMonth) : []),
    [rollbackRows, selectedMonth],
  );

  const rollbackView = useMemo(() => {
    const floor = rollbackForMonth.reduce((s, r) => s + (r.value_floor ?? 0), 0);
    const full = rollbackForMonth.reduce((s, r) => s + (r.value_full ?? 0), 0);
    const uncosted = rollbackForMonth.reduce((s, r) => s + (r.uncosted_qty ?? 0), 0);
    const byLocation = [...rollbackForMonth]
      .sort((a, b) => (b.value_full ?? 0) - (a.value_full ?? 0));
    return { floor, full, uncosted, byLocation };
  }, [rollbackForMonth]);

  const anchored = !!(summary && selectedMonth && summary.anchoredMonths.includes(selectedMonth));
  const dates = selectedMonth ? monthDates(selectedMonth) : null;

  /**
   * ONE METHOD, EVERYWHERE ON THIS PAGE — read this before adding a second number.
   *
   * The headline and the by-location breakdown both come from the backward
   * reconstruction (`fifo_rollback_valuation`), so they always foot to each other.
   *
   * They used to disagree, badly. A previous change moved the headline onto the
   * reconstruction but left the breakdowns on the forward usage simulation
   * (`fifo_valuation_summary`), and labelled the mismatch "prior method, for
   * reference" instead of fixing it. On 2026-03 that showed a $1.30M headline above
   * a by-location table totalling $7.01M — 5.4x apart, and in the other direction
   * (0.49x) on the latest month, so nobody could mentally correct for it.
   *
   * The reconstruction wins because it is the only method coherent over time: the
   * simulation OVERSTATES historical months (it runs forward over incomplete
   * records) and UNDERSTATES the current one (it goes strict there, excluding lot
   * quantities beyond matched receipts).
   *
   * The one exception is the category cut, which the reconstruction cannot do —
   * `fifo_rollback_valuation` has no category dimension. That table stays on the
   * simulation and is explicitly marked as not tying to the headline.
   *
   * `value_floor` vs `value_full` are collapsed: they are identical in 14 of 16
   * months (every month since 2026-04), so presenting them as two cards showed the
   * same number twice and cost the reader two pieces of jargon. `value_full` is the
   * one kept — it is the complete picture, using estimated cost only where a receipt
   * is missing.
   */
  const totalValue = basis === 'accrual' && rollbackForMonth.length > 0 ? rollbackView.full : view.total;
  /** True when the headline came from the reconstruction (accrual only). */
  const usingReconstruction = basis === 'accrual' && rollbackForMonth.length > 0;
  /** The simulation's total — the category table's own basis, shown so that table can state what it foots to. */
  const categoryTotal = view.total;

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Inventory (FIFO)</p>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Point-in-Time Inventory Value
            </h1>
            <p className={`text-sm mt-1 ${subText}`}>
              FIFO remaining inventory valued at actual purchase cost, as of a chosen month-end.
            </p>
          </div>
          <a href="/inventory" className={`px-3 py-2 text-sm rounded-lg border ${border} ${cardBg} self-start`}>
            ← Full valuation
          </a>
        </div>

        <Explainer id="inventory-as-of" title="What am I looking at?">
          <p>
            This page states what inventory was worth at the close of a chosen month, built lot-by-lot from actual
            LifeFile purchase receipts drawn down first-in-first-out, and reconstructed backward from
            LifeFile&rsquo;s lot report actuals.
          </p>
          <p>
            <strong>The total and the by-location table are the same number, cut two ways</strong> — the locations
            always add up to the headline. Both are built backward from what LifeFile&rsquo;s lot report says is
            actually on hand, rather than simulated forward from older, patchier records.
          </p>
          <p>
            <strong>The category table is the one exception.</strong> That breakdown isn&rsquo;t available in the
            figure above, so it is measured a different way and will not add up to the headline. Read it for the mix
            between categories, not for the dollar amounts. For category dollars, use the{' '}
            <strong>Full valuation</strong> page or the item-level export above.
          </p>
          <p>
            The monthly close — the roll-forward and the suggested adjusting entry against the QuickBooks
            inventory-asset balance — lives on the <strong>Journal Entries page</strong> under{' '}
            <strong>Inventory Close</strong>.
          </p>
          <p>
            These figures are best-available estimates built from pharmacy records — a consistent, reproducible
            method, not an audited count.
          </p>
        </Explainer>

        {error && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <label className={`text-sm ${subText}`}>As of end of</label>
          {/* Newest first — the close is almost always run for a recent month, and the
              API ships `months` oldest-first (latestMonth is derived from its tail).
              Reversing here is display-only so that derivation stays intact. Mirrors
              the End of Month and Inventory Close tabs. */}
          <select value={selectedMonth ?? ''} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
            {[...(summary?.months ?? [])].reverse().map((m) => {
              const d = monthDates(m);
              return (
                <option key={m} value={m}>
                  {m} (close {d.asOf})
                </option>
              );
            })}
          </select>
          <div className={`inline-flex rounded-lg border overflow-hidden ${border}`}>
            <button
              onClick={() => setBasis('accrual')}
              className={`px-3 py-2 text-sm font-medium ${basis === 'accrual' ? 'text-white' : subText}`}
              style={basis === 'accrual' ? { backgroundColor: '#5e3b8d' } : undefined}
            >
              Accrual
            </button>
            <button
              disabled={!summary?.hasCashBasis}
              onClick={() => setBasis('cash')}
              className={`px-3 py-2 text-sm font-medium ${
                summary?.hasCashBasis ? (basis === 'cash' ? 'text-white' : subText) : `cursor-not-allowed ${subText} opacity-50`
              }`}
              style={basis === 'cash' && summary?.hasCashBasis ? { backgroundColor: '#5e3b8d' } : undefined}
            >
              Cash
            </button>
          </div>
          <a
            href={`/api/inventory/summary?basis=${basis}&location=all&format=xlsx`}
            className={`ml-auto px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}
          >
            Excel (all months)
          </a>
        </div>

        {/* Item-level export for the selected month */}
        {selectedMonth && (
          <div className="flex flex-wrap items-center gap-2 -mt-2">
            <span className={`text-sm ${subText}`}>
              Item-level detail for {selectedMonth} (every product/lot):
            </span>
            <a
              href={`/api/inventory/lots?location=all&category=all&status=all&month=${encodeURIComponent(selectedMonth)}&format=csv`}
              className={`px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}
            >
              CSV
            </a>
            <a
              href={`/api/inventory/lots?location=all&category=all&status=all&month=${encodeURIComponent(selectedMonth)}&format=xlsx`}
              className={`px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}
            >
              Excel
            </a>
          </div>
        )}

        {/* The headline statement — ONE number, one method. See the comment on totalValue. */}
        {dates && (
          <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
            <p className={`text-sm ${subText}`}>
              On <strong>{dates.openingLong}</strong> (close of business {dates.asOf}), total inventory value is
            </p>
            <p className="text-4xl md:text-5xl font-bold mt-2">{usd.format(totalValue)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {usingReconstruction ? (
                <span
                  title="Rebuilt backward from what LifeFile's lot report says is on hand, rather than simulated forward from old records — checked by predicting months we could verify"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Built from LifeFile lot actuals
                </span>
              ) : anchored ? (
                <span
                  title="This month's remaining quantities were checked lot-by-lot against LifeFile's live lot report"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ LifeFile-reconciled
                </span>
              ) : (
                <span
                  title="No reconstruction available for this month and basis, so this falls back to the forward usage simulation, which overstates historical months"
                  className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold cursor-help"
                >
                  ⚠ Estimate only — not built from lot actuals
                </span>
              )}
              <span className={`text-xs ${subText}`}>{basis === 'accrual' ? 'Accrual basis' : 'Cash basis'}</span>
            </div>
            <p className={`text-xs mt-3 ${subText}`}>
              Stock on hand at month end, valued at what each lot actually cost — with an estimated cost only where the
              purchase receipt is missing.
              {usingReconstruction && rollbackView.uncosted > 0
                ? ` Excludes ${qty0.format(rollbackView.uncosted)} units with no cost basis at all.`
                : ''}
            </p>
          </div>
        )}

        {/* Breakdown by location — same source as the headline, so it always foots to it. */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <p className="text-sm font-semibold mb-3">By location</p>
          {usingReconstruction ? (
            <Breakdown
              map={new Map(rollbackView.byLocation.map((r) => [r.location, r.value_full ?? 0]))}
              total={totalValue}
              border={border}
              subText={subText}
            />
          ) : (
            <Breakdown map={view.byLocation} total={view.total} border={border} subText={subText} />
          )}
        </div>

        {/* Breakdown by category — the ONE place a different source is unavoidable:
            the reconstruction has no category dimension. Say so plainly and state the
            total it actually foots to, so it can never be read as a cut of the headline. */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <p className="text-sm font-semibold">By QuickBooks category</p>
          {usingReconstruction && Math.abs(categoryTotal - totalValue) > 1 && (
            <p
              className={`text-xs mt-1 mb-3 px-2 py-1.5 rounded border ${
                darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
              }`}
            >
              Category detail is not available in the figure above, so this table is measured a different way and totals{' '}
              <strong>{usd.format(categoryTotal)}</strong> — not the {usd.format(totalValue)} headline. Use it for the
              relative mix between categories, not for the dollar amounts.
            </p>
          )}
          <div className={usingReconstruction ? '' : 'mt-3'}>
            <Breakdown map={view.byCategory} total={categoryTotal} border={border} subText={subText} />
          </div>
        </div>

        {/* The monthly close (roll-forward + suggested JE) moved to the Journal Entries page. */}
        <p className={`text-sm ${subText}`}>
          Looking for the roll-forward &amp; suggested journal entry? The monthly close now lives on the{' '}
          <a href="/payroll?tab=inventoryclose" className="underline font-medium">
            Journal Entries page → Inventory Close
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Breakdown({
  map,
  total,
  border,
  subText,
}: {
  map: Map<string, number>;
  total: number;
  border: string;
  subText: string;
}) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className={`text-sm ${subText}`}>No data for this month.</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className={`border-t ${border}`}>
            <td className="py-2">{label.replace('MedRock ', '')}</td>
            <td className="py-2 text-right tabular-nums font-medium">{usd.format(value)}</td>
            <td className={`py-2 text-right tabular-nums ${subText} w-16`}>
              {total > 0 ? `${Math.round((value / total) * 100)}%` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
