'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { FlDr15Response } from '@/types/sales-tax';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Months to offer: from 2026-01 (feed start) back-to-front, excluding the current partial month. */
function recentMonths(): string[] {
  // Feed starts 2026-01; the current month is partial. Build a static-ish list
  // from a fixed anchor so the picker doesn't depend on Date in render.
  const months: string[] = [];
  for (let y = 2026; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
  }
  return months;
}

export default function SalesTaxFL() {
  const { darkMode } = useDarkMode();

  const [month, setMonth] = useState('2026-05');
  const [taxablePurchases, setTaxablePurchases] = useState('0');
  const [salesBasisOverride, setSalesBasisOverride] = useState('');
  const [data, setData] = useState<FlDr15Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams({ month });
    if (taxablePurchases && Number(taxablePurchases) !== 0) p.set('taxablePurchases', taxablePurchases);
    if (salesBasisOverride.trim() !== '') p.set('salesBasis', salesBasisOverride);
    return p.toString();
  }, [month, taxablePurchases, salesBasisOverride]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sales-tax/fl?${query}`)
      .then((r) => r.json() as Promise<FlDr15Response | { error: string }>)
      .then((d) => {
        if (cancelled) return;
        if ('error' in d) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const exportHref = useCallback(() => `/api/sales-tax/fl?${query}&format=xlsx`, [query]);

  const boxes = data?.boxes;
  const inputs = data?.inputs;
  const diag = data?.diagnostics;

  const BOX_ROWS = boxes
    ? [
        { line: 'Box 1', label: 'Gross Sales', value: boxes.box1_gross, big: true },
        { line: 'Box 2', label: 'Exempt Sales', value: boxes.box2_exempt, big: true },
        { line: 'Box 3', label: 'Total Taxable Amount', value: boxes.box3_taxable, big: false },
        { line: 'Box 4', label: 'Total Tax Due', value: boxes.box4_tax, big: false, highlight: true },
        { line: 'Box B', label: 'Discretionary Surtax (memo)', value: boxes.boxB_surtax, big: false },
        { line: 'Box 8a', label: 'Collection Allowance', value: boxes.box8a_allowance, big: false },
      ]
    : [];

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Sales Tax — Florida DR-15
            </h1>
            <p className={`text-sm ${subText}`}>
              Generated from the LifeFile sales-tax feed (FL-destination transactions). Method matches the
              accountant&apos;s workbook; taxable base uses 2026 county surtax rates.
              {data?.feedAsOf ? ` Feed as of ${new Date(data.feedAsOf).toLocaleDateString()}.` : ''}
            </p>
          </div>
          <a
            href={exportHref()}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white"
            style={{ backgroundColor: '#5e3b8d' }}
          >
            Download .xlsx
          </a>
        </div>

        {/* Controls */}
        <div className={`rounded-xl shadow-sm p-5 ${cardBg} flex flex-wrap items-end gap-4`}>
          <label className="flex flex-col gap-1">
            <span className={`text-xs uppercase tracking-wide ${subText}`}>Filing month</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
              {recentMonths().map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={`text-xs uppercase tracking-wide ${subText}`}>Taxable purchases (use tax)</span>
            <input
              type="number"
              step="0.01"
              value={taxablePurchases}
              onChange={(e) => setTaxablePurchases(e.target.value)}
              className={`${inputCls} w-44`}
              placeholder="0.00"
            />
            <span className={`text-[11px] ${subText}`}>from QB; usually 0</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={`text-xs uppercase tracking-wide ${subText}`}>Sales basis override</span>
            <input
              type="number"
              step="0.01"
              value={salesBasisOverride}
              onChange={(e) => setSalesBasisOverride(e.target.value)}
              className={`${inputCls} w-44`}
              placeholder="auto (summed sales)"
            />
            <span className={`text-[11px] ${subText}`}>blank = use summed sales</span>
          </label>
          {loading && <span className={`text-sm ${subText}`}>Loading…</span>}
        </div>

        {error && (
          <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {boxes && inputs && diag && (
          <>
            {/* DR-15 boxes */}
            <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg}`}>
              <table className="w-full text-sm">
                <tbody>
                  {BOX_ROWS.map((r) => (
                    <tr key={r.line} className={`border-t ${rowBorder}`}>
                      <td className="px-5 py-3 font-mono text-xs w-20">{r.line}</td>
                      <td className="px-2 py-3">{r.label}</td>
                      <td
                        className={`px-5 py-3 text-right tabular-nums ${
                          r.highlight ? 'font-bold' : ''
                        } ${r.big ? 'text-base' : ''}`}
                        style={r.highlight ? { color: '#5e3b8d' } : undefined}
                      >
                        {usd.format(r.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Derivation / diagnostics */}
            <div className={`rounded-xl shadow-sm p-5 ${cardBg} space-y-3`}>
              <p className="text-sm font-semibold">How these were derived</p>
              <div className={`grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm`}>
                <Row label="FL transactions" value={diag.totalTransactions.toLocaleString()} sub={subText} />
                <Row label="Taxable transactions" value={diag.taxableTransactions.toLocaleString()} sub={subText} />
                <Row
                  label={`Sales basis (${inputs.salesBasisSource === 'sales_sum' ? 'summed sales' : 'manual override'})`}
                  value={usd.format(inputs.salesBasis)}
                  sub={subText}
                />
                <Row label="Summed Total Sales" value={usd.format(diag.summedTotalSales)} sub={subText} />
                <Row label="Tax collected (F4)" value={usd.format(inputs.taxCollected)} sub={subText} />
                <Row
                  label="Taxable sales (E4, county-rate)"
                  value={usd.format(inputs.taxableSales)}
                  sub={subText}
                />
                <Row
                  label={`— vs flat ${(diag.flatRate * 100).toFixed(1)}% method`}
                  value={usd.format(diag.flatRateTaxableBase)}
                  sub={subText}
                />
                <Row label="Use tax on purchases (F7)" value={usd.format(inputs.salesUseTax)} sub={subText} />
              </div>
              {diag.unknownCountyRows > 0 && (
                <p className="text-xs text-amber-600">
                  {diag.unknownCountyRows} taxable transaction(s) had an unknown county — used the 1% default
                  surtax for those. Review before filing.
                </p>
              )}
              <p className={`text-xs ${subText}`}>
                Sales basis is the summed FL Subtotal (calibrated to the bank-statement deposit to the penny for
                Apr 2026). Tax collected reproduces the accountant&apos;s figure exactly. Taxable base divides each
                sale&apos;s tax by its delivery county&apos;s 2026 rate (6% + surtax), which correctly handles
                partially-taxable orders.
              </p>
            </div>

            {/* Ship-to states — nexus signal */}
            <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
              <p className="text-sm font-semibold mb-1">Ship-to states (FL location)</p>
              <p className={`text-xs mb-3 ${subText}`}>
                Where this location shipped in {month}. Out-of-state volume is the economic-nexus signal for a
                CPA review — not part of the FL return.
              </p>
              <div className="flex flex-wrap gap-2">
                {diag.shipToStates.slice(0, 30).map((s) => (
                  <span
                    key={s.state}
                    className={`text-xs px-2 py-1 rounded border ${rowBorder}`}
                    title={`${s.transactions} transactions`}
                  >
                    {s.state}: {usd.format(s.sales)}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className={sub}>{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}
