'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from './Explainer';
import CategoryLotDrilldown from './CategoryLotDrilldown';
import { monthDates } from '@/lib/inventory/month-dates';
import { shortInventoryLocation } from '@/lib/inventory/monthly-close';
import type {
  AsOfResponse,
  Basis,
  RollbackResponse,
  RollbackValuationRow,
  SummaryResponse,
  ValuationSummaryRow,
} from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * One (location, category) cell of the point-in-time value, normalized so the
 * rest of the page never branches on where the number came from.
 */
interface Cell {
  location: string;
  qbCategory: string;
  value: number;
  /** null on cash basis, which has no lot grain — see `drillable` below. */
  lotCount: number | null;
}

export default function InventorySnapshot() {
  const { darkMode } = useDarkMode();
  const [basis, setBasis] = useState<Basis>('accrual');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [asOf, setAsOf] = useState<AsOfResponse | null>(null);
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [month, setMonth] = useState<string | null>(null);
  const [location, setLocation] = useState<string>('all');
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  /** Set when we arrived from the Inventory Close tab, so we can offer a way back. */
  const [fromClose, setFromClose] = useState(false);

  // Deep link, read post-hydration so the server and first client render agree
  // (same approach as PayrollTabs). This is the entry point the close's category
  // rows link to: ?month=2026-03&location=MedRock%20Florida&category=Commercial%20Rx&from=close
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get('month');
    const loc = q.get('location');
    const cat = q.get('category');
    if (m) setMonth(m);
    if (loc) setLocation(loc);
    if (cat) setOpenCategory(cat);
    if (q.get('from') === 'close') setFromClose(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/rollback')
      .then((r) => r.json() as Promise<RollbackResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rows' in data) setRollbackRows(data.rows);
      })
      .catch(() => {
        // Non-fatal: the reconstruction is a cross-check, not the figure itself.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Summary supplies the location list, the anchored-month badges, and the CASH
  // basis figures (the lot ledger has no basis dimension). Not the accrual
  // numbers — those come from /api/inventory/as-of.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/inventory/summary?basis=${basis}&location=all`)
      .then((r) => r.json() as Promise<SummaryResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setError(data.error);
        else {
          setSummary(data);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [basis]);

  useEffect(() => {
    let cancelled = false;
    const url = month ? `/api/inventory/as-of?month=${encodeURIComponent(month)}` : '/api/inventory/as-of';
    fetch(url)
      .then((r) => r.json() as Promise<AsOfResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) {
          setError(data.error);
          return;
        }
        setAsOf(data);
        setError(null);
        // First load with no ?month= — adopt whatever the route resolved to.
        setMonth((prev) => prev ?? data.month);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const selectedMonth = month ?? asOf?.month ?? null;

  // Keep the address bar in step so this view is linkable and refreshable.
  // replaceState, not pushState: Back must return to whatever sent us here
  // (usually the close tab), not walk backwards through filter changes.
  useEffect(() => {
    if (!selectedMonth) return;
    const q = new URLSearchParams();
    q.set('month', selectedMonth);
    if (location !== 'all') q.set('location', location);
    if (openCategory) q.set('category', openCategory);
    if (fromClose) q.set('from', 'close');
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  }, [selectedMonth, location, openCategory, fromClose]);

  /**
   * THE NUMBERS ON THIS PAGE AND THE NUMBERS ON THE INVENTORY CLOSE ARE THE SAME
   * NUMBERS — read this before repointing anything at another table.
   *
   * Accrual cells come from /api/inventory/as-of, which calls the very function
   * the close builds its category lines from (`fetchCategoryLedgerValues`). Not a
   * second query that ought to agree — the same one. That is deliberate: this page
   * and the posted entry were stating different figures for the same month, and
   * the only durable fix is a single source rather than two that get reconciled.
   *
   * `inventory.fifo_valuation_summary` is NOT interchangeable with it. The two
   * tables agree on the total to the cent but disagree per category, because the
   * summary folds opening-balance lots into the product's real category while the
   * close leaves them under 'Opening Balance' (an OB lot has no QuickBooks
   * sub-account to post to). On 2026-03: identical $7,014,971.32 totals, but Texas
   * Compound Ingredient reads $507,498.36 there against $135,659.08 here.
   *
   * Cash basis is the one exception and is labelled as such on screen: the lot
   * ledger has no basis dimension, so cash falls back to the summary table, does
   * not tie to the close (which posts accrual), and cannot drill to receipts.
   */
  const cells = useMemo<Cell[]>(() => {
    if (basis === 'accrual') {
      return (asOf?.rows ?? []).map((r) => ({
        location: r.location,
        qbCategory: r.qbCategory,
        value: r.value,
        lotCount: r.lotCount,
      }));
    }
    const rows: ValuationSummaryRow[] =
      summary && selectedMonth ? summary.rows.filter((r) => r.as_of_month === selectedMonth) : [];
    return rows.map((r) => ({
      location: r.location,
      qbCategory: r.qb_category,
      value: r.on_hand_value_fifo,
      lotCount: null,
    }));
  }, [basis, asOf, summary, selectedMonth]);

  /** True when every figure on screen is the one the close posts from. */
  const drillable = basis === 'accrual';

  const scoped = useMemo(
    () => (location === 'all' ? cells : cells.filter((c) => c.location === location)),
    [cells, location],
  );

  const view = useMemo(() => {
    // Round at the CELL, then aggregate in integer cents. Rounding once at the
    // end instead lets two groupings of the same cells land a cent apart, and
    // the by-location table then fails to foot to the headline above it — on a
    // page whose entire claim is that these tie, that reads as a broken
    // reconciliation. One cell is one (location, category), which is also one
    // line of the close, so its rounding matches the close's line for line.
    const locCents = new Map<string, number>();
    const catCents = new Map<string, number>();
    const lotsByCategory = new Map<string, number>();
    let totalCents = 0;
    for (const c of scoped) {
      const cents = Math.round(c.value * 100);
      totalCents += cents;
      locCents.set(c.location, (locCents.get(c.location) ?? 0) + cents);
      catCents.set(c.qbCategory, (catCents.get(c.qbCategory) ?? 0) + cents);
      if (c.lotCount !== null) {
        lotsByCategory.set(c.qbCategory, (lotsByCategory.get(c.qbCategory) ?? 0) + c.lotCount);
      }
    }
    const toDollars = (m: Map<string, number>): Map<string, number> =>
      new Map([...m].map(([k, cents]) => [k, cents / 100]));
    return {
      total: totalCents / 100,
      byLocation: toDollars(locCents),
      byCategory: toDollars(catCents),
      lotsByCategory,
    };
  }, [scoped]);

  // The backward reconstruction, kept as a CROSS-CHECK only. It cannot be the
  // headline any more: it has no category or lot dimension, so nothing on it can
  // be traced to a receipt, which is the thing the close has to prove. It still
  // earns its place — it is built backward from LifeFile's lot report, so a wide
  // gap is the honest signal that a month's forward simulation is running high.
  const rollbackForMonth = useMemo<RollbackValuationRow[]>(
    () =>
      selectedMonth
        ? rollbackRows.filter(
            (r) => r.as_of_month === selectedMonth && (location === 'all' || r.location === location),
          )
        : [],
    [rollbackRows, selectedMonth, location],
  );
  const rollbackTotal = useMemo(
    () => rollbackForMonth.reduce((s, r) => s + (r.value_full ?? 0), 0),
    [rollbackForMonth],
  );
  const hasCrossCheck = drillable && rollbackForMonth.length > 0;

  const anchored = !!(summary && selectedMonth && summary.anchoredMonths.includes(selectedMonth));
  const dates = selectedMonth ? monthDates(selectedMonth) : null;
  const months = asOf?.months ?? [];

  const toggleCategory = useCallback(
    (category: string) => setOpenCategory((v) => (v === category ? null : category)),
    [],
  );

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const lotsHref = (cat: string, format: 'csv' | 'xlsx'): string =>
    `/api/inventory/lots?location=${encodeURIComponent(location)}&category=${encodeURIComponent(cat)}` +
    `&status=all&month=${encodeURIComponent(selectedMonth ?? '')}&format=${format}`;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-4xl mx-auto space-y-6">
        {fromClose && selectedMonth && (
          <a
            href={`/payroll?tab=inventoryclose&month=${encodeURIComponent(selectedMonth)}`}
            className={`inline-flex items-center gap-1.5 text-sm font-medium underline ${
              darkMode ? 'text-blue-300' : 'text-blue-600'
            }`}
          >
            ← Back to the {selectedMonth} inventory close
          </a>
        )}

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
            LifeFile purchase receipts drawn down first-in-first-out.
          </p>
          <p>
            <strong>Every figure here is the same figure the month-end journal entry posts from.</strong> The total,
            the locations, and the categories are one number cut three ways, and they add up. Click any category to
            see the products behind it, then any product to see the individual purchase receipts — quantity, unit
            cost, and remaining value — so an entry can be traced from the posted amount down to the document.
          </p>
          <p>
            <strong>The reconstruction cross-check</strong> at the bottom is a second, independent estimate built
            backward from LifeFile&rsquo;s lot report. It is not what posts. When it sits far below the figure above,
            that month&rsquo;s forward simulation is likely running high — worth knowing before signing off, which is
            why it is shown rather than hidden.
          </p>
          <p>
            The roll-forward and the adjusting entry itself live on the <strong>Journal Entries page</strong> under{' '}
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
          {/* Newest first — the close is almost always run for a recent month, and
              the API ships `months` oldest-first. Reversing is display-only. */}
          <select
            value={selectedMonth ?? ''}
            onChange={(e) => {
              setMonth(e.target.value);
              setOpenCategory(null);
            }}
            className={inputCls}
          >
            {[...months].reverse().map((m) => {
              const d = monthDates(m);
              return (
                <option key={m} value={m}>
                  {m} (close {d.asOf})
                </option>
              );
            })}
          </select>
          <select
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setOpenCategory(null);
            }}
            className={inputCls}
          >
            <option value="all">All locations</option>
            {(summary?.locations ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
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
              onClick={() => {
                setBasis('cash');
                setOpenCategory(null);
              }}
              className={`px-3 py-2 text-sm font-medium ${
                summary?.hasCashBasis
                  ? basis === 'cash'
                    ? 'text-white'
                    : subText
                  : `cursor-not-allowed ${subText} opacity-50`
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

        {/* Item-level export for the current month + location scope */}
        {selectedMonth && (
          <div className="flex flex-wrap items-center gap-2 -mt-2">
            <span className={`text-sm ${subText}`}>
              Item-level detail for {selectedMonth}
              {location === 'all' ? '' : ` · ${shortInventoryLocation(location)}`} (every product/lot):
            </span>
            <a href={lotsHref('all', 'csv')} className={`px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}>
              CSV
            </a>
            <a href={lotsHref('all', 'xlsx')} className={`px-3 py-2 text-sm rounded-lg border ${border} ${cardBg}`}>
              Excel
            </a>
          </div>
        )}

        {/* The headline statement */}
        {dates && (
          <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
            <p className={`text-sm ${subText}`}>
              On <strong>{dates.openingLong}</strong> (close of business {dates.asOf}),{' '}
              {location === 'all' ? 'total inventory value is' : `${shortInventoryLocation(location)} inventory value is`}
            </p>
            <p className="text-4xl md:text-5xl font-bold mt-2">{usd.format(view.total)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {drillable ? (
                <span
                  title="This is the figure the inventory-close journal entry posts from, summed from the same lot ledger — every dollar traces to a purchase receipt"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Ties to the month-end journal entry
                </span>
              ) : (
                <span
                  title="Cash basis re-times purchases to their QuickBooks payment date. The close posts on the accrual basis, so this figure does not tie to it and has no receipt-level drill-down."
                  className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold cursor-help"
                >
                  ⚠ Cash basis — does not tie to the close
                </span>
              )}
              {anchored && (
                <span
                  title="This month's remaining quantities were checked lot-by-lot against LifeFile's live lot report"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ LifeFile-reconciled
                </span>
              )}
              <span className={`text-xs ${subText}`}>{basis === 'accrual' ? 'Accrual basis' : 'Cash basis'}</span>
            </div>
            <p className={`text-xs mt-3 ${subText}`}>
              Stock on hand at month end, valued at what each lot actually cost — with an estimated cost only where the
              purchase receipt is missing.
            </p>
          </div>
        )}

        {/* By location — same cells as the headline, so it always foots to it. */}
        {location === 'all' && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold mb-3">By location</p>
            <LocationBreakdown
              map={view.byLocation}
              total={view.total}
              border={border}
              subText={subText}
              darkMode={darkMode}
              onSelect={(loc) => {
                setLocation(loc);
                setOpenCategory(null);
              }}
            />
          </div>
        )}

        {/* By category — the close's own grain, expandable to products then receipts. */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-sm font-semibold">
              By QuickBooks category
              {location === 'all' ? '' : ` — ${shortInventoryLocation(location)}`}
            </p>
            {location !== 'all' && (
              <button
                onClick={() => {
                  setLocation('all');
                  setOpenCategory(null);
                }}
                className={`text-xs underline ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
              >
                ← All locations
              </button>
            )}
          </div>
          <CategoryBreakdown
            map={view.byCategory}
            lots={view.lotsByCategory}
            total={view.total}
            border={border}
            subText={subText}
            darkMode={darkMode}
            drillable={drillable}
            openCategory={openCategory}
            onToggle={toggleCategory}
            location={location}
            month={selectedMonth}
          />
          {!drillable && (
            <p className={`text-xs mt-3 ${subText}`}>
              Receipt-level detail is accrual-only — switch to Accrual to trace these figures to their lots.
            </p>
          )}
        </div>

        {/* The reconstruction, as a cross-check. Never the headline: no category,
            no lot, nothing to trace. */}
        {hasCrossCheck && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold">Reconstruction cross-check</p>
            <p className={`text-xs mt-1 ${subText}`}>
              An independent estimate built backward from LifeFile&rsquo;s lot report, for the same month and scope.
              It has no category or lot detail, so it cannot be traced to receipts and is not what the journal entry
              posts.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-6">
              <div>
                <p className={`text-xs ${subText}`}>Reconstruction</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(rollbackTotal)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Variance vs. the figure above</p>
                <p className="text-xl font-bold tabular-nums" style={{ color: '#2563eb' }}>
                  {usd.format(rollbackTotal - view.total)}
                </p>
              </div>
            </div>
            {Math.abs(rollbackTotal - view.total) > 0.25 * Math.max(Math.abs(view.total), 1) && (
              <p
                className={`text-xs mt-3 px-2 py-1.5 rounded border ${
                  darkMode
                    ? 'bg-amber-950/30 border-amber-800 text-amber-200'
                    : 'bg-amber-50 border-amber-300 text-amber-800'
                }`}
              >
                These are far apart. Months that LifeFile has not anchored are simulated forward over incomplete
                purchase records and tend to run high, so treat the figure above as the traceable number rather than
                the settled one, and expect the adjusting entry to be large.
              </p>
            )}
          </div>
        )}

        <p className={`text-sm ${subText}`}>
          Looking for the roll-forward &amp; suggested journal entry? The monthly close lives on the{' '}
          <a
            href={`/payroll?tab=inventoryclose${selectedMonth ? `&month=${encodeURIComponent(selectedMonth)}` : ''}`}
            className="underline font-medium"
          >
            Journal Entries page → Inventory Close
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function LocationBreakdown({
  map,
  total,
  border,
  subText,
  darkMode,
  onSelect,
}: {
  map: Map<string, number>;
  total: number;
  border: string;
  subText: string;
  darkMode: boolean;
  onSelect: (location: string) => void;
}) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className={`text-sm ${subText}`}>No data for this month.</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr
            key={label}
            onClick={() => onSelect(label)}
            title={`Show only ${shortInventoryLocation(label)}`}
            className={`border-t cursor-pointer ${border} ${darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}
          >
            <td className="py-2">{shortInventoryLocation(label)}</td>
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

function CategoryBreakdown({
  map,
  lots,
  total,
  border,
  subText,
  darkMode,
  drillable,
  openCategory,
  onToggle,
  location,
  month,
}: {
  map: Map<string, number>;
  lots: Map<string, number>;
  total: number;
  border: string;
  subText: string;
  darkMode: boolean;
  drillable: boolean;
  openCategory: string | null;
  onToggle: (category: string) => void;
  location: string;
  month: string | null;
}) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className={`text-sm ${subText}`}>No data for this month.</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <tr
              onClick={drillable ? () => onToggle(label) : undefined}
              className={`border-t ${border} ${
                drillable ? `cursor-pointer ${darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}` : ''
              }`}
            >
              <td className="py-2">
                <span className="flex items-center gap-1">
                  {drillable &&
                    (openCategory === label ? (
                      <ChevronDown className="w-3 h-3 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0" aria-hidden />
                    ))}
                  {label}
                </span>
              </td>
              <td className={`py-2 text-right tabular-nums ${subText} w-20`}>
                {lots.has(label) ? `${lots.get(label)?.toLocaleString()} lots` : ''}
              </td>
              <td className="py-2 text-right tabular-nums font-medium">{usd.format(value)}</td>
              <td className={`py-2 text-right tabular-nums ${subText} w-16`}>
                {total > 0 ? `${Math.round((value / total) * 100)}%` : '—'}
              </td>
            </tr>
            {drillable && openCategory === label && month && (
              <tr>
                <td colSpan={4} className={darkMode ? 'bg-slate-800/60' : 'bg-slate-50'}>
                  <CategoryLotDrilldown
                    location={location}
                    qbCategory={label}
                    month={month}
                    darkMode={darkMode}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
