'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type {
  Basis,
  LocationAnalyticsResponse,
  LocationAnalyticsRow,
  LocationTrendsResponse,
  LocationForecastResponse,
} from '@/types/location-analytics';
import { TrendsPanel } from './location-analytics/TrendsPanel';
import { ForecastPanel } from './location-analytics/ForecastPanel';

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

type Tab = 'summary' | 'charts' | 'forecast';

function defaultStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  d.setDate(1);
  return d.toISOString().split('T')[0];
}

function defaultEndDate(): string {
  const d = new Date();
  d.setDate(0); // last day of previous month
  return d.toISOString().split('T')[0];
}

function fmtCurrency(value: number | null): string {
  return value === null ? '—' : usd0.format(value);
}

function fmtPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

export function LocationAnalytics() {
  const { darkMode } = useDarkMode();

  const [startDate, setStartDate] = useState<string>(defaultStartDate);
  const [endDate, setEndDate] = useState<string>(defaultEndDate);
  const [basis, setBasis] = useState<Basis>('Cash');
  const [threshold, setThreshold] = useState<number>(5);
  const [activeTab, setActiveTab] = useState<Tab>('summary');

  const [data, setData] = useState<LocationAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Trends are lazy-loaded only when the Charts tab is first opened (they make
  // ~months × locations sequential QB calls — too slow for the Summary load).
  const [trends, setTrends] = useState<LocationTrendsResponse | null>(null);
  const [trendsLoading, setTrendsLoading] = useState<boolean>(false);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const trendsKey = `${startDate}|${endDate}|${basis}`;
  const attemptedKeyRef = useRef<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ startDate, endDate, basis, threshold: String(threshold) });
      const res = await fetch(`/api/location-analytics?${params}`);
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load location analytics');
      }
      setData((await res.json()) as LocationAnalyticsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, basis, threshold]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchTrends = useCallback(async () => {
    attemptedKeyRef.current = `${startDate}|${endDate}|${basis}`;
    setTrendsLoading(true);
    setTrendsError(null);
    try {
      const params = new URLSearchParams({ startDate, endDate, basis });
      const res = await fetch(`/api/location-analytics/trends?${params}`);
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load trends');
      }
      setTrends((await res.json()) as LocationTrendsResponse);
    } catch (err) {
      setTrendsError(err instanceof Error ? err.message : 'Unknown error');
      setTrends(null);
    } finally {
      setTrendsLoading(false);
    }
  }, [startDate, endDate, basis]);

  // Fetch trends once per (tab open × filter set). Uses a ref so a failed fetch
  // doesn't loop — the user retries via the button instead.
  useEffect(() => {
    if (activeTab === 'charts' && attemptedKeyRef.current !== trendsKey && !trendsLoading) {
      fetchTrends();
    }
  }, [activeTab, trendsKey, trendsLoading, fetchTrends]);

  // Forecast: lazy-loaded when the Forecast tab opens. The 24-month window is
  // server-derived, so the only filter that affects it is Basis.
  const [forecast, setForecast] = useState<LocationForecastResponse | null>(null);
  const [forecastLoading, setForecastLoading] = useState<boolean>(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const attemptedForecastBasisRef = useRef<string | null>(null);

  const fetchForecast = useCallback(async () => {
    attemptedForecastBasisRef.current = basis;
    setForecastLoading(true);
    setForecastError(null);
    try {
      const res = await fetch(`/api/location-analytics/forecast?${new URLSearchParams({ basis })}`);
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load forecast');
      }
      setForecast((await res.json()) as LocationForecastResponse);
    } catch (err) {
      setForecastError(err instanceof Error ? err.message : 'Unknown error');
      setForecast(null);
    } finally {
      setForecastLoading(false);
    }
  }, [basis]);

  useEffect(() => {
    if (activeTab === 'forecast' && attemptedForecastBasisRef.current !== basis && !forecastLoading) {
      fetchForecast();
    }
  }, [activeTab, basis, forecastLoading, fetchForecast]);

  const exportHref = (format: 'csv' | 'xlsx'): string => {
    const params = new URLSearchParams({ startDate, endDate, basis, threshold: String(threshold), format });
    return `/api/location-analytics?${params}`;
  };

  // Theme tokens — matched to the Inventory (FIFO) page
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const tableHead = darkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const fifoUnavailable = (data?.locations ?? []).some((l) => !l.rds.fifoBasisAvailable);

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-screen-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Location Analytics
            </h1>
            <p className={`text-sm ${subText}`}>
              QuickBooks P&amp;L by location, cross-checked against LifeFile sales and FIFO inventory.
              {data?.feedAsOf ? ` LifeFile feed as of ${new Date(data.feedAsOf).toLocaleDateString()}.` : ''}
            </p>
          </div>

          {/* Basis toggle (applies to all tabs) + Summary-only exports */}
          <div className="flex items-center gap-3">
            <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
              {(['Cash', 'Accrual'] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setBasis(b)}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    basis === b ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}
                  style={basis === b ? { backgroundColor: '#5e3b8d' } : undefined}
                >
                  {b}
                </button>
              ))}
            </div>
            {activeTab === 'summary' && (
              <div className="flex gap-2">
                <a href={exportHref('csv')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}>
                  CSV
                </a>
                <a href={exportHref('xlsx')} className={`px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg}`}>
                  Excel
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Tab bar (moved up — drives the filter section below) */}
        <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
          {([
            { key: 'summary', label: 'Summary' },
            { key: 'charts', label: 'Trends & Charts' },
            { key: 'forecast', label: 'Forecast' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-5 py-2 text-sm font-medium transition-colors ${
                activeTab === t.key ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
              }`}
              style={activeTab === t.key ? { backgroundColor: '#5e3b8d' } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filter section — respects the active tab */}
        {activeTab === 'forecast' ? (
          <div className={`rounded-xl shadow-sm p-4 text-xs ${cardBg} ${subText}`}>
            Forecast uses a fixed trailing <strong>24-month</strong> QuickBooks history (through the last completed
            month). Date and variance filters don&apos;t apply here — only the <strong>{basis}</strong> basis toggle
            above.
          </div>
        ) : (
          <div className={`rounded-xl shadow-sm p-4 flex flex-wrap items-end gap-4 ${cardBg}`}>
            <label className="flex flex-col gap-1">
              <span className={`text-xs uppercase tracking-wide ${subText}`}>Start Date</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={`text-xs uppercase tracking-wide ${subText}`}>End Date</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </label>
            {activeTab === 'summary' && (
              <label className="flex flex-col gap-1">
                <span className={`text-xs uppercase tracking-wide ${subText}`}>Variance Flag (%)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={threshold}
                  onChange={(e) => setThreshold(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}
                  className={`${inputCls} w-28`}
                />
              </label>
            )}
            {data && (
              <span className={`text-xs ml-auto ${subText}`}>
                {data.basis} basis · {data.startDate} → {data.endDate}
              </span>
            )}
          </div>
        )}

        {/* Read-only / methodology note (Summary + Trends only) */}
        {activeTab !== 'forecast' && (
          <div className={`rounded-xl shadow-sm p-4 text-xs ${cardBg} ${subText}`}>
            Read-only investigative view — nothing here writes to QuickBooks or the data warehouse. LifeFile Sales =
            Σ dispensed Subtotal (pre-tax, all ship-to states), a timing/scope cross-check rather than a GL revenue
            account. QB COGS includes payroll booked to COGS (acct 5010) while FIFO COGS is materials only, so a COGS
            variance is expected.
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>
        )}

        {loading && (
          <div className={`rounded-xl shadow-sm p-12 text-center ${cardBg}`}>
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto" />
            <p className={`mt-4 ${subText}`}>Loading QuickBooks + RDS data…</p>
          </div>
        )}

        {/* ── Summary tab ───────────────────────────────────────────── */}
        {data && !loading && activeTab === 'summary' && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <SummaryCard label="Total Revenue (QB)" cardBg={cardBg} subText={subText}>
                <p className="text-2xl font-bold mt-1">{fmtCurrency(data.totals.revenue)}</p>
                <p className={`text-xs mt-1 ${subText}`}>LifeFile {fmtCurrency(data.totals.lifefileSales)}</p>
              </SummaryCard>
              <SummaryCard label="Gross Profit" cardBg={cardBg} subText={subText}>
                <p className="text-2xl font-bold mt-1">{fmtCurrency(data.totals.grossProfit)}</p>
                <p className={`text-xs mt-1 ${subText}`}>{fmtPercent(data.totals.grossMarginPercent)} margin</p>
              </SummaryCard>
              <SummaryCard label="Net Income" cardBg={cardBg} subText={subText}>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    data.totals.netIncome >= 0 ? 'text-emerald-500' : 'text-red-500'
                  }`}
                >
                  {fmtCurrency(data.totals.netIncome)}
                </p>
                <p className={`text-xs mt-1 ${subText}`}>{fmtPercent(data.totals.netMarginPercent)} margin</p>
              </SummaryCard>
              <SummaryCard label="On-Hand Inventory (FIFO)" cardBg={cardBg} subText={subText}>
                <p className="text-2xl font-bold mt-1" style={{ color: '#5e3b8d' }}>
                  {fmtCurrency(data.totals.onHandInventory)}
                </p>
                {fifoUnavailable && <p className={`text-xs mt-1 ${subText}`}>unavailable on {data.basis} basis</p>}
              </SummaryCard>
            </div>

            {/* Reconciliation cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data.locations.map((loc) => (
                <ReconCard
                  key={loc.qbLocation}
                  loc={loc}
                  cardBg={cardBg}
                  subText={subText}
                  rowBorder={rowBorder}
                />
              ))}
            </div>

            {/* Location comparison table */}
            <div className={`rounded-xl shadow-sm ${cardBg}`}>
              <div className={`p-4 border-b ${rowBorder}`}>
                <p className="text-sm font-semibold">Location Comparison</p>
                <p className={`text-xs ${subText}`}>Complete P&amp;L by location with RDS cross-check ({data.basis} basis)</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={tableHead}>
                      <th className="px-3 py-2 text-left font-medium">Location</th>
                      <th className="px-3 py-2 text-right font-medium">QB Revenue</th>
                      <th className="px-3 py-2 text-right font-medium">LifeFile Sales</th>
                      <th className="px-3 py-2 text-right font-medium">Rev Δ%</th>
                      <th className="px-3 py-2 text-right font-medium">QB COGS</th>
                      <th className="px-3 py-2 text-right font-medium">FIFO COGS</th>
                      <th className="px-3 py-2 text-right font-medium">COGS Δ%</th>
                      <th className="px-3 py-2 text-right font-medium">Gross Profit</th>
                      <th className="px-3 py-2 text-right font-medium">Payroll</th>
                      <th className="px-3 py-2 text-right font-medium">Operating</th>
                      <th className="px-3 py-2 text-right font-medium">Net Income</th>
                      <th className="px-3 py-2 text-right font-medium">On-Hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locations.map((loc) => (
                      <tr
                        key={loc.qbLocation}
                        className={`border-t ${rowBorder} ${darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="font-medium">{loc.label}</span>
                          {!loc.connected && (
                            <span className={`ml-2 text-[10px] uppercase ${subText}`}>QB not connected</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{loc.qb ? fmtCurrency(loc.qb.revenue) : '—'}</td>
                        <td className={`px-3 py-2 text-right ${subText}`}>{fmtCurrency(loc.rds.lifefileSales)}</td>
                        <td className="px-3 py-2 text-right">
                          <DeltaPill
                            percent={loc.reconciliation?.revenueVariancePercent ?? null}
                            flagged={loc.reconciliation?.revenueFlagged ?? false}
                            subText={subText}
                          />
                        </td>
                        <td className={`px-3 py-2 text-right ${subText}`}>{loc.qb ? fmtCurrency(loc.qb.cogs) : '—'}</td>
                        <td className={`px-3 py-2 text-right ${subText}`}>{fmtCurrency(loc.rds.fifoCogs)}</td>
                        <td className="px-3 py-2 text-right">
                          <DeltaPill
                            percent={loc.reconciliation?.cogsVariancePercent ?? null}
                            flagged={loc.reconciliation?.cogsFlagged ?? false}
                            subText={subText}
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-medium">{loc.qb ? fmtCurrency(loc.qb.grossProfit) : '—'}</td>
                        <td className={`px-3 py-2 text-right ${subText}`}>{loc.qb ? fmtCurrency(loc.qb.payrollTotal) : '—'}</td>
                        <td className={`px-3 py-2 text-right ${subText}`}>
                          {loc.qb ? fmtCurrency(loc.qb.operatingExpensesTotal) : '—'}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-medium ${
                            loc.qb ? (loc.qb.netIncome >= 0 ? 'text-emerald-500' : 'text-red-500') : ''
                          }`}
                        >
                          {loc.qb ? fmtCurrency(loc.qb.netIncome) : '—'}
                        </td>
                        <td className={`px-3 py-2 text-right ${subText}`}>{fmtCurrency(loc.rds.onHandInventory)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={`border-t-2 ${rowBorder} font-bold`}>
                      <td className="px-3 py-2">TOTAL</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.revenue)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.lifefileSales)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.cogs)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.fifoCogs)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.grossProfit)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.payrollTotal)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.operatingExpensesTotal)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.netIncome)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(data.totals.onHandInventory)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {fifoUnavailable && (
                <div className={`px-4 py-3 text-xs ${subText}`}>
                  FIFO COGS / on-hand are unavailable for the <strong>{data.basis}</strong> basis (no rows yet) — switch
                  to Accrual, or wait for the Data Loader to ship cash-basis valuation rows.
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Trends & Charts tab ───────────────────────────────────── */}
        {activeTab === 'charts' && (
          <>
            {trendsLoading && (
              <div className={`rounded-xl shadow-sm p-12 text-center ${cardBg}`}>
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto" />
                <p className={`mt-4 ${subText}`}>
                  Building monthly trends from QuickBooks — one P&amp;L pull per month per location, this can take a
                  moment for longer ranges…
                </p>
              </div>
            )}

            {trendsError && !trendsLoading && (
              <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm flex items-center justify-between">
                <span>{trendsError}</span>
                <button
                  onClick={fetchTrends}
                  className="ml-4 px-3 py-1 rounded-md bg-red-200 hover:bg-red-300 text-red-900 font-medium"
                >
                  Retry
                </button>
              </div>
            )}

            {trends && !trendsLoading && (
              <TrendsPanel
                trends={trends}
                darkMode={darkMode}
                cardBg={cardBg}
                subText={subText}
                rowBorder={rowBorder}
              />
            )}
          </>
        )}

        {/* ── Forecast tab ──────────────────────────────────────────── */}
        {activeTab === 'forecast' && (
          <>
            {forecastLoading && (
              <div className={`rounded-xl shadow-sm p-12 text-center ${cardBg}`}>
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto" />
                <p className={`mt-4 ${subText}`}>
                  Pulling 24 months of QuickBooks history (one report per location)…
                </p>
              </div>
            )}

            {forecastError && !forecastLoading && (
              <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm flex items-center justify-between">
                <span>{forecastError}</span>
                <button
                  onClick={fetchForecast}
                  className="ml-4 px-3 py-1 rounded-md bg-red-200 hover:bg-red-300 text-red-900 font-medium"
                >
                  Retry
                </button>
              </div>
            )}

            {forecast && !forecastLoading && (
              <ForecastPanel
                forecast={forecast}
                darkMode={darkMode}
                cardBg={cardBg}
                subText={subText}
                rowBorder={rowBorder}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  cardBg,
  subText,
  children,
}: {
  label: string;
  cardBg: string;
  subText: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className={`text-xs uppercase tracking-wide ${subText}`}>{label}</p>
      {children}
    </div>
  );
}

function ReconCard({
  loc,
  cardBg,
  subText,
  rowBorder,
}: {
  loc: LocationAnalyticsRow;
  cardBg: string;
  subText: string;
  rowBorder: string;
}) {
  const r = loc.reconciliation;
  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <div className="flex items-center justify-between">
        <p className="font-semibold">{loc.label}</p>
        {!loc.connected && <span className={`text-[10px] uppercase ${subText}`}>QB not connected</span>}
      </div>
      {!r ? (
        <p className={`text-sm mt-3 ${subText}`}>No QuickBooks data to reconcile.</p>
      ) : (
        <div className="mt-3 space-y-2">
          <ReconLine
            label="Revenue"
            qb={loc.qb ? usd0.format(loc.qb.revenue) : '—'}
            rds={fmtCurrency(loc.rds.lifefileSales)}
            percent={r.revenueVariancePercent}
            flagged={r.revenueFlagged}
            subText={subText}
            rowBorder={rowBorder}
          />
          <ReconLine
            label="COGS"
            qb={loc.qb ? usd0.format(loc.qb.cogs) : '—'}
            rds={fmtCurrency(loc.rds.fifoCogs)}
            percent={r.cogsVariancePercent}
            flagged={r.cogsFlagged}
            subText={subText}
            rowBorder={rowBorder}
          />
        </div>
      )}
    </div>
  );
}

function ReconLine({
  label,
  qb,
  rds,
  percent,
  flagged,
  subText,
  rowBorder,
}: {
  label: string;
  qb: string;
  rds: string;
  percent: number | null;
  flagged: boolean;
  subText: string;
  rowBorder: string;
}) {
  return (
    <div className={`flex items-center justify-between border-t pt-2 ${rowBorder}`}>
      <div className="text-sm">
        <span className="font-medium">{label}</span>
        <span className={`ml-2 text-xs ${subText}`}>
          QB {qb} · RDS {rds}
        </span>
      </div>
      <DeltaPill percent={percent} flagged={flagged} subText={subText} />
    </div>
  );
}

function DeltaPill({
  percent,
  flagged,
  subText,
}: {
  percent: number | null;
  flagged: boolean;
  subText: string;
}) {
  if (percent === null) return <span className={`text-xs ${subText}`}>—</span>;
  const sign = percent > 0 ? '+' : '';
  const label = `${sign}${percent.toFixed(1)}%`;
  if (flagged) {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 font-medium">
        {label} ⚑
      </span>
    );
  }
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-medium">{label}</span>
  );
}
