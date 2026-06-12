'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type {
  Basis,
  LotRow,
  LotsResponse,
  ProductDetailResponse,
  SummaryResponse,
  ValuationSummaryRow,
} from '@/types/inventory';

const PAGE_SIZE = 50;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const CATEGORY_COLORS: Record<string, string> = {
  'Commercial Rx': '#2563eb',
  'Compound Ingredient': '#5e3b8d',
  Uncoded: '#d97706',
  'Opening Balance': '#64748b',
};

export default function InventoryValuation() {
  const { darkMode } = useDarkMode();

  const [basis, setBasis] = useState<Basis>('accrual');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [location, setLocation] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState(0);

  const [lots, setLots] = useState<LotsResponse | null>(null);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [lotsError, setLotsError] = useState<string | null>(null);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/inventory/summary?basis=${basis}&location=${encodeURIComponent(location)}`)
      .then((r) => r.json() as Promise<SummaryResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setSummaryError(data.error);
        else {
          setSummary(data);
          setSummaryError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setSummaryError(e instanceof Error ? e.message : 'Failed to load summary');
      });
    return () => {
      cancelled = true;
    };
  }, [basis, location]);

  const lotsQuery = useMemo(() => {
    const params = new URLSearchParams({
      location,
      category,
      status,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    return params.toString();
  }, [location, category, status, debouncedSearch, page]);

  useEffect(() => {
    let cancelled = false;
    setLotsLoading(true);
    fetch(`/api/inventory/lots?${lotsQuery}`)
      .then((r) => r.json() as Promise<LotsResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('error' in data) setLotsError(data.error);
        else {
          setLots(data);
          setLotsError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLotsError(e instanceof Error ? e.message : 'Failed to load lots');
      })
      .finally(() => {
        if (!cancelled) setLotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lotsQuery]);

  const toggleExpand = useCallback(
    (row: LotRow) => {
      const key = row.product_key;
      if (expandedKey === key) {
        setExpandedKey(null);
        setDetail(null);
        return;
      }
      setExpandedKey(key);
      setDetail(null);
      setDetailLoading(true);
      fetch(`/api/inventory/product?key=${encodeURIComponent(key)}&location=${encodeURIComponent(location)}`)
        .then((r) => r.json() as Promise<ProductDetailResponse | { error: string }>)
        .then((data) => {
          if (!('error' in data)) setDetail(data);
        })
        .finally(() => setDetailLoading(false));
    },
    [expandedKey, location],
  );

  const latestMonth = summary?.latestMonth ?? null;

  const currentMonthRows = useMemo<ValuationSummaryRow[]>(
    () => (summary && latestMonth ? summary.rows.filter((r) => r.as_of_month === latestMonth) : []),
    [summary, latestMonth],
  );

  const totals = useMemo(() => {
    const total = currentMonthRows.reduce((s, r) => s + r.on_hand_value_fifo, 0);
    const ob = currentMonthRows.reduce((s, r) => s + r.opening_balance_value, 0);
    const shortfalls = currentMonthRows.reduce((s, r) => s + r.shortfall_count, 0);
    const byCategory = new Map<string, number>();
    for (const r of currentMonthRows) {
      byCategory.set(r.qb_category, (byCategory.get(r.qb_category) ?? 0) + r.on_hand_value_fifo);
    }
    return { total, ob, shortfalls, byCategory };
  }, [currentMonthRows]);

  const chartData = useMemo(() => {
    if (!summary) return [];
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const r of summary.rows) {
      const entry = byMonth.get(r.as_of_month) ?? { month: r.as_of_month, Total: 0 };
      entry[r.qb_category] = ((entry[r.qb_category] as number | undefined) ?? 0) + r.on_hand_value_fifo;
      entry.Total = (entry.Total as number) + r.on_hand_value_fifo;
      byMonth.set(r.as_of_month, entry);
    }
    return [...byMonth.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }, [summary]);

  const exportHref = useCallback(
    (kind: 'summary' | 'lots', format: 'csv' | 'xlsx'): string => {
      if (kind === 'summary') {
        return `/api/inventory/summary?basis=${basis}&location=${encodeURIComponent(location)}&format=${format}`;
      }
      const params = new URLSearchParams({ location, category, status, format });
      if (debouncedSearch) params.set('search', debouncedSearch);
      return `/api/inventory/lots?${params.toString()}`;
    },
    [basis, location, category, status, debouncedSearch],
  );

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-screen-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Inventory Valuation (FIFO)
            </h1>
            <p className={`text-sm ${subText}`}>
              Lot-level purchases depleted first-in-first-out, valued at actual purchase price.
              {latestMonth ? ` Data as of ${latestMonth} (nightly Data Loader run).` : ''}
            </p>
          </div>

          {/* Basis toggle */}
          <div className="flex items-center gap-3">
            <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
              <button
                onClick={() => setBasis('accrual')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  basis === 'accrual' ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
                }`}
                style={basis === 'accrual' ? { backgroundColor: '#5e3b8d' } : undefined}
              >
                Accrual
              </button>
              <button
                disabled
                title="Cash basis arrives with the QuickBooks linkage phase — receipts re-timed to payment dates"
                className={`px-4 py-2 text-sm font-medium cursor-not-allowed ${darkMode ? 'text-slate-600' : 'text-slate-400'}`}
              >
                Cash
              </button>
            </div>
            <div className="flex gap-2">
              <a href={exportHref('summary', 'csv')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}>
                CSV
              </a>
              <a href={exportHref('summary', 'xlsx')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}>
                Excel
              </a>
            </div>
          </div>
        </div>

        {summaryError && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">
            {summaryError}
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className={`text-xs uppercase tracking-wide ${subText}`}>Total On-Hand Value</p>
            <p className="text-2xl font-bold mt-1">{usd0.format(totals.total)}</p>
            <p className={`text-xs mt-1 ${subText}`}>
              incl. {usd0.format(totals.ob)} estimated opening balance
            </p>
          </div>
          {['Commercial Rx', 'Compound Ingredient', 'Uncoded'].map((cat) => (
            <div key={cat} className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
              <p className={`text-xs uppercase tracking-wide ${subText}`}>{cat}</p>
              <p className="text-2xl font-bold mt-1" style={{ color: CATEGORY_COLORS[cat] }}>
                {usd0.format(totals.byCategory.get(cat) ?? 0)}
              </p>
              {cat === 'Uncoded' && (totals.byCategory.get(cat) ?? 0) > 0 && (
                <p className={`text-xs mt-1 ${subText}`}>needs drug coding</p>
              )}
            </div>
          ))}
        </div>

        {/* Trend chart */}
        {chartData.length > 1 && (
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className={`text-sm font-semibold mb-3`}>On-Hand Value by Month</p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#334155' : '#e2e8f0'} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke={darkMode ? '#94a3b8' : '#64748b'} />
                  <YAxis
                    tickFormatter={(v: number) => usd0.format(v)}
                    tick={{ fontSize: 12 }}
                    stroke={darkMode ? '#94a3b8' : '#64748b'}
                    width={90}
                  />
                  <Tooltip formatter={(v: number | undefined) => usd.format(v ?? 0)} />
                  <Legend />
                  <Line type="monotone" dataKey="Total" stroke="#16a34a" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Commercial Rx" stroke={CATEGORY_COLORS['Commercial Rx']} dot={false} />
                  <Line type="monotone" dataKey="Compound Ingredient" stroke={CATEGORY_COLORS['Compound Ingredient']} dot={false} />
                  <Line type="monotone" dataKey="Uncoded" stroke={CATEGORY_COLORS['Uncoded']} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Filters + lot table */}
        <div className={`rounded-xl shadow-sm ${cardBg}`}>
          <div className="p-4 flex flex-wrap items-center gap-3 border-b border-inherit">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search product, NDC, or lot #"
              className={`${inputCls} w-64`}
            />
            <select
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                setPage(0);
              }}
              className={inputCls}
            >
              <option value="all">All Locations</option>
              {(summary?.locations ?? []).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(0);
              }}
              className={inputCls}
            >
              <option value="all">All Categories</option>
              {(summary?.categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="Opening Balance">Opening Balance</option>
            </select>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
              className={inputCls}
            >
              <option value="all">All Lots</option>
              <option value="open">Open (qty remaining)</option>
              <option value="fully_used">Fully Used</option>
            </select>
            <div className="ml-auto flex gap-2">
              <a href={exportHref('lots', 'csv')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder}`}>
                Export CSV
              </a>
              <a href={exportHref('lots', 'xlsx')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder}`}>
                Export Excel
              </a>
            </div>
          </div>

          {lotsError && <div className="p-4 text-sm text-red-600">{lotsError}</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHead}>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Lot #</th>
                  <th className="px-3 py-2 text-left font-medium">Location</th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-left font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Qty Rcvd</th>
                  <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Remaining</th>
                  <th className="px-3 py-2 text-right font-medium">Value Left</th>
                  <th className="px-3 py-2 text-left font-medium">Fully Used</th>
                </tr>
              </thead>
              <tbody>
                {lotsLoading && (
                  <tr>
                    <td colSpan={10} className={`px-3 py-8 text-center ${subText}`}>
                      Loading…
                    </td>
                  </tr>
                )}
                {!lotsLoading && (lots?.rows.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={10} className={`px-3 py-8 text-center ${subText}`}>
                      No lots match the current filters.
                    </td>
                  </tr>
                )}
                {!lotsLoading &&
                  lots?.rows.map((row) => (
                    <LotTableRow
                      key={row.receipt_id}
                      row={row}
                      expanded={expandedKey === row.product_key}
                      onToggle={() => toggleExpand(row)}
                      detail={expandedKey === row.product_key ? detail : null}
                      detailLoading={expandedKey === row.product_key && detailLoading}
                      darkMode={darkMode}
                      rowBorder={rowBorder}
                      subText={subText}
                    />
                  ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className={`p-4 flex items-center justify-between text-sm ${subText}`}>
            <span>
              {lots ? `${lots.total.toLocaleString()} lots · page ${page + 1} of ${Math.max(1, Math.ceil(lots.total / PAGE_SIZE))}` : ''}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40`}
              >
                Previous
              </button>
              <button
                disabled={!lots || (page + 1) * PAGE_SIZE >= lots.total}
                onClick={() => setPage((p) => p + 1)}
                className={`px-3 py-1.5 rounded-lg border ${rowBorder} disabled:opacity-40`}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface LotTableRowProps {
  row: LotRow;
  expanded: boolean;
  onToggle: () => void;
  detail: ProductDetailResponse | null;
  detailLoading: boolean;
  darkMode: boolean;
  rowBorder: string;
  subText: string;
}

function LotTableRow({ row, expanded, onToggle, detail, detailLoading, darkMode, rowBorder, subText }: LotTableRowProps) {
  const productNumber = row.ndc || (row.product_key.startsWith('name:') ? null : row.product_key);
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t ${rowBorder} cursor-pointer transition-colors ${
          darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'
        }`}
      >
        <td className="px-3 py-2">
          <div className="font-medium flex items-center gap-2">
            {row.product_name ?? row.product_key}
            {row.is_opening_balance && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-500 uppercase">OB</span>
            )}
            {row.had_shortfall && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 uppercase">Shortfall</span>
            )}
          </div>
          {productNumber && <div className={`text-xs ${subText}`}>{productNumber}</div>}
        </td>
        <td className="px-3 py-2">{row.lot_number ?? '—'}</td>
        <td className="px-3 py-2">{row.location.replace('MedRock ', '')}</td>
        <td className="px-3 py-2">{row.qb_category}</td>
        <td className="px-3 py-2">
          {row.date_received ?? (row.ob_as_of_month ? `As of ${row.ob_as_of_month}` : '—')}
        </td>
        <td className="px-3 py-2 text-right">{row.qty_received !== null ? qty.format(row.qty_received) : '—'}</td>
        <td className="px-3 py-2 text-right">{row.unit_cost !== null ? usd.format(row.unit_cost) : '—'}</td>
        <td className="px-3 py-2 text-right">{qty.format(row.qty_remaining)}</td>
        <td className="px-3 py-2 text-right font-medium">
          {row.remaining_value !== null ? usd.format(row.remaining_value) : '—'}
        </td>
        <td className="px-3 py-2">
          {row.fully_used_month ? (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-medium">
              {row.fully_used_month}
            </span>
          ) : (
            <span className={`text-xs ${subText}`}>open</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={`border-t ${rowBorder}`}>
          <td colSpan={10} className={`px-6 py-4 ${darkMode ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
            {detailLoading && <p className={`text-sm ${subText}`}>Loading FIFO history…</p>}
            {detail && (
              <div className="space-y-3">
                <p className="text-sm font-semibold">
                  FIFO queue — {detail.product_name ?? detail.product_key}
                  {detail.product_name && !detail.product_key.startsWith('name:')
                    ? ` (${detail.product_key})`
                    : ''}
                </p>
                {detail.locations.map((loc) => {
                  const locReceipts = detail.receipts.filter((r) => r.location === loc);
                  if (locReceipts.length === 0) return null;
                  return (
                    <div key={loc}>
                      {detail.locations.length > 1 && (
                        <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${subText}`}>
                          {loc.replace('MedRock ', '')}
                        </p>
                      )}
                      <table className="w-full text-xs">
                        <thead>
                          <tr className={subText}>
                            <th className="text-left py-1 pr-3 font-medium">#</th>
                            <th className="text-left py-1 pr-3 font-medium">Received</th>
                            <th className="text-left py-1 pr-3 font-medium">Lot</th>
                            <th className="text-left py-1 pr-3 font-medium">Vendor</th>
                            <th className="text-right py-1 pr-3 font-medium">Qty</th>
                            <th className="text-right py-1 pr-3 font-medium">Unit Cost</th>
                            <th className="text-right py-1 pr-3 font-medium">Consumed</th>
                            <th className="text-right py-1 pr-3 font-medium">Remaining</th>
                            <th className="text-left py-1 font-medium">Fully Used</th>
                          </tr>
                        </thead>
                        <tbody>
                          {locReceipts.map((r) => (
                            <tr key={r.receipt_id} className={`border-t ${rowBorder}`}>
                              <td className="py-1 pr-3">{r.fifo_position}</td>
                              <td className="py-1 pr-3">
                                {r.is_opening_balance
                                  ? `Opening balance${r.ob_as_of_month ? ` (as of ${r.ob_as_of_month})` : ''}`
                                  : r.date_received ?? '—'}
                              </td>
                              <td className="py-1 pr-3">{r.lot_number ?? '—'}</td>
                              <td className="py-1 pr-3">{r.vendor ?? '—'}</td>
                              <td className="py-1 pr-3 text-right">
                                {r.qty_received !== null ? qty.format(r.qty_received) : '—'}
                              </td>
                              <td className="py-1 pr-3 text-right">
                                {r.unit_cost !== null ? usd.format(r.unit_cost) : '—'}
                              </td>
                              <td className="py-1 pr-3 text-right">{qty.format(r.qty_consumed)}</td>
                              <td className="py-1 pr-3 text-right">{qty.format(r.qty_remaining)}</td>
                              <td className="py-1">{r.fully_used_month ?? 'open'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
