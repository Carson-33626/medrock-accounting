'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { Basis, LocationAnalyticsResponse, LocationAnalyticsRow } from '@/types/location-analytics';

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
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(1)}%`;
}

function fmtSignedPercent(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function LocationAnalytics() {
  const { darkMode } = useDarkMode();

  const [startDate, setStartDate] = useState<string>(defaultStartDate);
  const [endDate, setEndDate] = useState<string>(defaultEndDate);
  const [basis, setBasis] = useState<Basis>('Cash');
  const [threshold, setThreshold] = useState<number>(5);

  const [data, setData] = useState<LocationAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        startDate,
        endDate,
        basis,
        threshold: String(threshold),
      });
      const res = await fetch(`/api/location-analytics?${params}`);
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load location analytics');
      }
      const json: LocationAnalyticsResponse = await res.json();
      setData(json);
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

  const download = (format: 'csv' | 'xlsx') => {
    const params = new URLSearchParams({ startDate, endDate, basis, threshold: String(threshold), format });
    window.location.href = `/api/location-analytics?${params}`;
  };

  // Theme tokens
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-200';
  const cardText = darkMode ? 'text-slate-100' : 'text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const headBg = darkMode ? 'bg-slate-900/50' : 'bg-gray-50';
  const inputCls = `w-full px-3 py-2 rounded-lg border ${
    darkMode ? 'bg-slate-700 border-slate-600 text-white' : 'bg-white border-gray-300 text-gray-900'
  }`;
  const rowDivide = darkMode ? 'divide-slate-700' : 'divide-gray-200';
  const flagCls = darkMode
    ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
    : 'bg-amber-50 border-amber-200 text-amber-900';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Company</p>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Location Analytics
            </h1>
            <p className={`text-sm mt-1 ${subText}`}>
              QuickBooks P&amp;L by location, cross-checked against LifeFile sales and FIFO inventory.
              {data?.feedAsOf && (
                <> · LifeFile feed as of {new Date(data.feedAsOf).toLocaleDateString()}</>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => download('csv')}
              disabled={!data || loading}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: '#5e3b8d' }}
            >
              Export CSV
            </button>
            <button
              onClick={() => download('xlsx')}
              disabled={!data || loading}
              className={`px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 ${
                darkMode ? 'border-slate-600 text-slate-200' : 'border-gray-300 text-gray-700'
              }`}
            >
              Export Excel
            </button>
          </div>
        </div>

        {/* Read-only / investigative note */}
        <div className={`rounded-lg border px-3 py-2 text-xs ${flagCls}`}>
          Read-only investigative view. LifeFile Sales = Σ dispensed Subtotal (pre-tax, all ship-to states) —
          a timing/scope cross-check, not a GL revenue account. QB COGS includes payroll booked to COGS
          (acct 5010) while FIFO COGS is materials only, so a COGS variance is expected. Nothing here writes
          to QuickBooks or the data warehouse.
        </div>

        {/* Controls */}
        <div className={`rounded-xl border shadow-sm p-5 ${cardBg}`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${subText}`}>Start Date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${subText}`}>End Date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${subText}`}>Accounting Basis</label>
              <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className={inputCls}>
                <option value="Cash">Cash</option>
                <option value="Accrual">Accrual</option>
              </select>
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${subText}`}>Variance Flag Threshold (%)</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={threshold}
                onChange={(e) => setThreshold(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}
                className={inputCls}
              />
            </div>
          </div>
        </div>

        {loading && (
          <div className={`rounded-xl border shadow-sm p-12 text-center ${cardBg} ${cardText}`}>
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto" />
            <p className={`mt-4 ${subText}`}>Loading QuickBooks + RDS data…</p>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-5">
            <p className="text-red-800 dark:text-red-200 text-sm">Error: {error}</p>
          </div>
        )}

        {data && !loading && (
          <>
            {/* KPI cards (totals) */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <KpiCard label="Total Revenue (QB)" value={fmtCurrency(data.totals.revenue)} cardBg={cardBg} cardText={cardText} subText={subText} />
              <KpiCard label="Gross Profit" value={fmtCurrency(data.totals.grossProfit)} sub={fmtPercent(data.totals.grossMarginPercent)} cardBg={cardBg} cardText={cardText} subText={subText} />
              <KpiCard
                label="Net Income"
                value={fmtCurrency(data.totals.netIncome)}
                sub={fmtPercent(data.totals.netMarginPercent)}
                positive={data.totals.netIncome >= 0}
                cardBg={cardBg}
                cardText={cardText}
                subText={subText}
              />
              <KpiCard label="On-Hand Inventory (FIFO)" value={fmtCurrency(data.totals.onHandInventory)} cardBg={cardBg} cardText={cardText} subText={subText} />
            </div>

            {/* Reconciliation strip */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${cardBg}`}>
              <div className={`p-5 border-b ${darkMode ? 'border-slate-700' : 'border-gray-200'}`}>
                <h2 className={`text-lg font-semibold ${cardText}`}>Reconciliation</h2>
                <p className={`text-sm ${subText}`}>
                  QuickBooks vs operations — flagged when |variance| &gt; {data.varianceThresholdPercent}%.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-px">
                {data.locations.map((loc) => (
                  <ReconCard key={loc.qbLocation} loc={loc} cardBg={cardBg} cardText={cardText} subText={subText} darkMode={darkMode} flagCls={flagCls} />
                ))}
              </div>
            </div>

            {/* Location comparison table */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${cardBg}`}>
              <div className={`p-5 border-b ${darkMode ? 'border-slate-700' : 'border-gray-200'}`}>
                <h2 className={`text-lg font-semibold ${cardText}`}>Location Comparison</h2>
                <p className={`text-sm ${subText}`}>Complete P&amp;L by location with RDS cross-check ({data.basis} basis)</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className={headBg}>
                    <tr>
                      <Th align="left" subText={subText}>Location</Th>
                      <Th subText={subText}>QB Revenue</Th>
                      <Th subText={subText}>LifeFile Sales</Th>
                      <Th subText={subText}>Rev Δ%</Th>
                      <Th subText={subText}>QB COGS</Th>
                      <Th subText={subText}>FIFO COGS</Th>
                      <Th subText={subText}>COGS Δ%</Th>
                      <Th subText={subText}>Gross Profit</Th>
                      <Th subText={subText}>Payroll</Th>
                      <Th subText={subText}>Operating</Th>
                      <Th subText={subText}>Net Income</Th>
                      <Th subText={subText}>On-Hand</Th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${rowDivide}`}>
                    {data.locations.map((loc) => (
                      <tr key={loc.qbLocation} className={darkMode ? 'hover:bg-slate-900/30' : 'hover:bg-gray-50'}>
                        <td className={`px-4 py-3 whitespace-nowrap font-medium ${cardText}`}>
                          {loc.label}
                          {!loc.connected && <span className={`ml-2 text-[10px] uppercase ${subText}`}>QB not connected</span>}
                        </td>
                        <Td cardText={cardText}>{loc.qb ? fmtCurrency(loc.qb.revenue) : '—'}</Td>
                        <Td subText={subText}>{fmtCurrency(loc.rds.lifefileSales)}</Td>
                        <Td flagged={loc.reconciliation?.revenueFlagged}>{fmtSignedPercent(loc.reconciliation?.revenueVariancePercent ?? null)}</Td>
                        <Td subText={subText}>{loc.qb ? fmtCurrency(loc.qb.cogs) : '—'}</Td>
                        <Td subText={subText}>{fmtCurrency(loc.rds.fifoCogs)}</Td>
                        <Td flagged={loc.reconciliation?.cogsFlagged}>{fmtSignedPercent(loc.reconciliation?.cogsVariancePercent ?? null)}</Td>
                        <Td cardText={cardText}>{loc.qb ? fmtCurrency(loc.qb.grossProfit) : '—'}</Td>
                        <Td subText={subText}>{loc.qb ? fmtCurrency(loc.qb.payrollTotal) : '—'}</Td>
                        <Td subText={subText}>{loc.qb ? fmtCurrency(loc.qb.operatingExpensesTotal) : '—'}</Td>
                        <Td cardText={cardText}>{loc.qb ? fmtCurrency(loc.qb.netIncome) : '—'}</Td>
                        <Td subText={subText}>{fmtCurrency(loc.rds.onHandInventory)}</Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className={headBg}>
                    <tr className={`font-bold ${cardText}`}>
                      <td className="px-4 py-3">TOTAL</td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.revenue)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.lifefileSales)}</Td>
                      <td className="px-4 py-3" />
                      <Td cardText={cardText}>{fmtCurrency(data.totals.cogs)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.fifoCogs)}</Td>
                      <td className="px-4 py-3" />
                      <Td cardText={cardText}>{fmtCurrency(data.totals.grossProfit)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.payrollTotal)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.operatingExpensesTotal)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.netIncome)}</Td>
                      <Td cardText={cardText}>{fmtCurrency(data.totals.onHandInventory)}</Td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {data.locations.some((l) => !l.rds.fifoBasisAvailable) && (
                <div className={`px-5 py-3 text-xs ${subText}`}>
                  FIFO COGS / on-hand are unavailable for the <strong>{data.basis}</strong> basis (no rows yet) —
                  switch to Accrual, or wait for the Data Loader to ship cash-basis valuation rows.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  positive,
  cardBg,
  cardText,
  subText,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  cardBg: string;
  cardText: string;
  subText: string;
}) {
  const valueColor = positive === undefined ? cardText : positive ? 'text-emerald-500' : 'text-red-500';
  return (
    <div className={`rounded-xl border shadow-sm p-5 ${cardBg}`}>
      <p className={`text-sm ${subText}`}>{label}</p>
      <p className={`text-2xl font-bold mt-1 ${valueColor}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${subText}`}>{sub}</p>}
    </div>
  );
}

function ReconCard({
  loc,
  cardText,
  subText,
  darkMode,
  flagCls,
}: {
  loc: LocationAnalyticsRow;
  cardBg: string;
  cardText: string;
  subText: string;
  darkMode: boolean;
  flagCls: string;
}) {
  const r = loc.reconciliation;
  return (
    <div className={`p-5 ${darkMode ? 'bg-slate-800' : 'bg-white'}`}>
      <div className="flex items-center justify-between">
        <p className={`font-semibold ${cardText}`}>{loc.label}</p>
        {!loc.connected && <span className={`text-[10px] uppercase ${subText}`}>QB not connected</span>}
      </div>
      {!r ? (
        <p className={`text-sm mt-2 ${subText}`}>No QuickBooks data to reconcile.</p>
      ) : (
        <div className="mt-3 space-y-2">
          <ReconLine
            label="Revenue"
            qb={loc.qb ? fmtCurrency(loc.qb.revenue) : '—'}
            rds={fmtCurrency(loc.rds.lifefileSales)}
            delta={fmtSignedPercent(r.revenueVariancePercent)}
            flagged={r.revenueFlagged}
            subText={subText}
            cardText={cardText}
            flagCls={flagCls}
          />
          <ReconLine
            label="COGS"
            qb={loc.qb ? fmtCurrency(loc.qb.cogs) : '—'}
            rds={fmtCurrency(loc.rds.fifoCogs)}
            delta={fmtSignedPercent(r.cogsVariancePercent)}
            flagged={r.cogsFlagged}
            subText={subText}
            cardText={cardText}
            flagCls={flagCls}
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
  delta,
  flagged,
  subText,
  cardText,
  flagCls,
}: {
  label: string;
  qb: string;
  rds: string;
  delta: string;
  flagged: boolean;
  subText: string;
  cardText: string;
  flagCls: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div>
        <span className={`font-medium ${cardText}`}>{label}</span>
        <span className={`ml-2 ${subText}`}>
          QB {qb} · RDS {rds}
        </span>
      </div>
      <span
        className={`px-2 py-0.5 rounded text-xs font-semibold ${
          flagged ? `border ${flagCls}` : subText
        }`}
      >
        {delta}
        {flagged ? ' ⚑' : ''}
      </span>
    </div>
  );
}

function Th({ children, align = 'right', subText }: { children: React.ReactNode; align?: 'left' | 'right'; subText: string }) {
  return (
    <th className={`px-4 py-3 text-${align} text-xs font-medium uppercase tracking-wider ${subText}`}>{children}</th>
  );
}

function Td({
  children,
  cardText,
  subText,
  flagged,
}: {
  children: React.ReactNode;
  cardText?: string;
  subText?: string;
  flagged?: boolean;
}) {
  const cls = flagged ? 'text-amber-500 font-semibold' : cardText || subText || '';
  return <td className={`px-4 py-3 whitespace-nowrap text-right ${cls}`}>{children}</td>;
}
