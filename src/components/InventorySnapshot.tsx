'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type {
  Basis,
  RollbackResponse,
  RollbackValuationRow,
  SummaryResponse,
  ValuationSummaryRow,
} from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const qty0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 'YYYY-MM' → { asOf: last day of that month, opening: first day of next month } as M/D/YYYY. */
function monthDates(month: string): { asOf: string; opening: string; openingLong: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return { asOf: month, opening: month, openingLong: month };
  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10); // 1..12
  const last = new Date(Date.UTC(year, mon, 0)); // day 0 of next month = last day of this month
  const open = new Date(Date.UTC(year, mon, 1)); // first day of next month
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  const fmtLong = (d: Date) =>
    d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return { asOf: fmt(last), opening: fmt(open), openingLong: fmtLong(open) };
}

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

  const isLatestMonth = !!(summary && selectedMonth && selectedMonth === summary.latestMonth);
  // Dual bases are accrual-only; cash keeps the original single headline entirely.
  const showDual = basis === 'accrual' && rollbackForMonth.length > 0;
  // Card A (floor): the latest month keeps the penny-validated lot-anchored summary
  // figure as its floor of record; historical months use the rollback floor.
  const floorValue = isLatestMonth ? view.total : rollbackView.floor;

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

        {error && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <label className={`text-sm ${subText}`}>As of end of</label>
          <select value={selectedMonth ?? ''} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
            {(summary?.months ?? []).map((m) => {
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

        {/* The headline statement */}
        {dates && (
          showDual ? (
            <>
              <p className={`text-sm ${subText}`}>
                On <strong>{dates.openingLong}</strong> (close of business {dates.asOf}), total inventory value is
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Card A — receipt-priced floor */}
                <div className={`rounded-2xl shadow-sm p-6 ${cardBg}`}>
                  <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Receipt-priced floor</p>
                  <p className="text-3xl md:text-4xl font-bold mt-2">{usd.format(floorValue)}</p>
                  <p className={`text-xs mt-2 ${subText}`}>
                    Only stock traceable to a priced receipt. Conservative — understates true value.
                  </p>
                  {isLatestMonth && anchored && (
                    <div className="mt-3">
                      <span className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                        ✓ LifeFile-reconciled
                      </span>
                    </div>
                  )}
                </div>

                {/* Card B — full-coverage estimate */}
                <div className={`rounded-2xl shadow-sm p-6 ${cardBg}`}>
                  <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Full-coverage estimate</p>
                  <p className="text-3xl md:text-4xl font-bold mt-2">{usd.format(rollbackView.full)}</p>
                  <p className={`text-xs mt-2 ${subText}`}>
                    Everything on the LifeFile lot report, valued at receipt costs with estimated costs where receipts
                    are missing.
                  </p>
                  {rollbackView.uncosted > 0 && (
                    <p className={`text-xs mt-2 ${subText}`}>
                      excludes {qty0.format(rollbackView.uncosted)} units with no cost basis
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                  ✓ Reconstructed from LifeFile lot actuals (backward rollback, out-of-sample validated)
                </span>
                <span className={`text-xs ${subText}`}>Accrual basis</span>
              </div>
              <p className={`text-xs ${subText}`}>
                Two valuation bases are shown pending accounting&rsquo;s selection of the official basis.
              </p>
            </>
          ) : (
            <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
              <p className={`text-sm ${subText}`}>
                On <strong>{dates.openingLong}</strong> (close of business {dates.asOf}), total inventory value is
              </p>
              <p className="text-4xl md:text-5xl font-bold mt-2">{usd.format(view.total)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {anchored ? (
                  <span className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold">
                    ✓ LifeFile-reconciled
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
                    ⚠ Estimate — usage simulation, not yet LifeFile-anchored
                  </span>
                )}
                <span className={`text-xs ${subText}`}>
                  {basis === 'accrual' ? 'Accrual basis' : 'Cash basis'} · includes {usd0.format(view.ob)} estimated opening balance
                </span>
              </div>
              {!anchored && (
                <p className={`text-xs mt-3 ${subText}`}>
                  Historical months are valued by the usage simulation, which overstates on-hand inventory. This figure
                  becomes reconciled once the Data Loader runs Phase 2d (historical LifeFile anchoring) and the receiving
                  backfill reaches this date. See docs/superpowers/specs/2026-06-17-fifo-phase2d-historical-anchoring.md.
                </p>
              )}
            </div>
          )
        )}

        {showDual && <p className="text-sm font-semibold">Breakdown (receipt-priced basis)</p>}

        {/* Breakdown by location */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <p className="text-sm font-semibold mb-3">By location</p>
          <Breakdown map={view.byLocation} total={view.total} border={border} subText={subText} />
        </div>

        {/* Breakdown by QB category */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <p className="text-sm font-semibold mb-3">By QuickBooks category</p>
          <Breakdown map={view.byCategory} total={view.total} border={border} subText={subText} />
        </div>

        {/* Per-location rollback bases (accrual, when reconstructed data exists) */}
        {showDual && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold mb-3">By location — rollback bases</p>
            <table className="w-full text-sm">
              <thead>
                <tr className={`text-xs uppercase tracking-wider ${subText}`}>
                  <th className="py-2 text-left font-semibold">Location</th>
                  <th className="py-2 text-right font-semibold">Receipt-priced floor</th>
                  <th className="py-2 text-right font-semibold">Full-coverage estimate</th>
                </tr>
              </thead>
              <tbody>
                {rollbackView.byLocation.map((r) => (
                  <tr key={r.location} className={`border-t ${border}`}>
                    <td className="py-2">{r.location.replace('MedRock ', '')}</td>
                    <td className="py-2 text-right tabular-nums font-medium">{usd.format(r.value_floor ?? 0)}</td>
                    <td className="py-2 text-right tabular-nums font-medium">{usd.format(r.value_full ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
