'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { TnReturnResponse } from '@/types/sales-tax';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const FILING_SLUG = 'tennessee/tn';
// Tennessee TNTAP portal (Sales & Use → View/File Returns).
const TNTAP_URL = 'https://tntap.tn.gov/eservices/_/#4';
const TNTAP_LOGIN = 'Medrockton';
const TNTAP_PASSWORD = 'Shallow11sford$';
const TN_ACCOUNT = '1002172027-SLC';

interface SavedInputs {
  taxablePurchases: number | null;
  salesBasisOverride: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Feed starts 2026-01; earlier years aren't reproducible from the feed.
const FILING_YEARS: string[] = ['2026', '2027'];

export default function SalesTaxTN() {
  const { darkMode } = useDarkMode();

  const thisYear = String(new Date().getFullYear());
  const [period, setPeriod] = useState(() => (FILING_YEARS.includes(thisYear) ? thisYear : '2026'));
  const [taxablePurchases, setTaxablePurchases] = useState('0');
  const [data, setData] = useState<TnReturnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [savedInputs, setSavedInputs] = useState<SavedInputs>({
    taxablePurchases: null,
    salesBasisOverride: null,
    updatedAt: null,
    updatedBy: null,
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [loadingInputs, setLoadingInputs] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams({ period });
    if (taxablePurchases && Number(taxablePurchases) !== 0) p.set('taxablePurchases', taxablePurchases);
    return p.toString();
  }, [period, taxablePurchases]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sales-tax/tn?${query}`)
      .then((r) => r.json() as Promise<TnReturnResponse | { error: string }>)
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

  useEffect(() => {
    let cancelled = false;
    setLoadingInputs(true);
    setSaveState('idle');
    fetch(`/api/sales-tax/inputs?slug=${encodeURIComponent(FILING_SLUG)}&month=${period}`)
      .then((r) => r.json() as Promise<SavedInputs | { error: string }>)
      .then((d) => {
        if (cancelled || 'error' in d) return;
        setSavedInputs(d);
        setTaxablePurchases(d.taxablePurchases != null ? String(d.taxablePurchases) : '0');
      })
      .catch(() => {
        /* leave defaults */
      })
      .finally(() => {
        if (!cancelled) setLoadingInputs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const parsedTP = taxablePurchases.trim() === '' ? 0 : Number(taxablePurchases);
  const dirty = parsedTP !== (savedInputs.taxablePurchases ?? 0);

  const saveInputs = useCallback(async () => {
    setSaveState('saving');
    try {
      const resp = await fetch('/api/sales-tax/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: FILING_SLUG, month: period, taxablePurchases: parsedTP, salesBasisOverride: null }),
      });
      const d = (await resp.json()) as { ok?: boolean; updatedAt?: string | null; updatedBy?: string | null; error?: string };
      if (!resp.ok || !d.ok) throw new Error(d.error || 'save failed');
      setSavedInputs({ taxablePurchases: parsedTP, salesBasisOverride: null, updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null });
      setSaveState('idle');
    } catch {
      setSaveState('error');
    }
  }, [period, parsedTP]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm w-full ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const exportHref = useCallback((fmt: 'csv' | 'pdf' | 'xlsx') => `/api/sales-tax/tn?${query}&format=${fmt}`, [query]);

  const boxes = data?.boxes;
  const diag = data?.diagnostics;

  return (
    <div className="space-y-6">
      <p className={`text-sm ${subText}`}>
        Generated from the LifeFile feed. Taxable Sales backs out of the 9.25% combined rate (Σ Tax ÷ 9.25%, per the
        filing SOP), so the total tax ties to what was collected; Gross Sales = summed Subtotal; Exempt = Gross −
        Taxable.{data?.feedAsOf ? ` Feed as of ${new Date(data.feedAsOf).toLocaleDateString()}.` : ''}
      </p>

      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          <Field label="Filing year" hint="Annual return, period ending Dec 31, due Jan 20. Feed starts Jan 2026." sub={subText}>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputCls}>
              {FILING_YEARS.map((y) => (
                <option key={y} value={y}>
                  CY{y}
                  {y === thisYear ? '  — current (in progress)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Taxable purchases"
            affects="Use tax"
            hint="Cost of property purchased for use (use tax) from QuickBooks — usually 0."
            sub={subText}
          >
            <input
              type="number"
              step="0.01"
              value={taxablePurchases}
              onChange={(e) => setTaxablePurchases(e.target.value)}
              className={inputCls}
              placeholder="0.00"
            />
          </Field>
          <Field label="Export (summary + source)" hint={loading ? 'loading…' : ' '} sub={subText}>
            <div className="flex gap-2">
              {(['csv', 'pdf', 'xlsx'] as const).map((fmt) => (
                <a
                  key={fmt}
                  href={exportHref(fmt)}
                  className={`flex-1 text-center px-3 py-2 text-sm rounded-lg border ${rowBorder} ${cardBg} hover:opacity-80`}
                >
                  {fmt.toUpperCase()}
                </a>
              ))}
            </div>
          </Field>
        </div>

        <div className={`mt-4 pt-4 border-t ${rowBorder} flex items-center justify-between gap-3 flex-wrap`}>
          <span className={`text-xs ${dirty || saveState === 'error' ? 'text-amber-600' : subText}`}>
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? 'Save failed — try again.'
                : dirty
                  ? 'Unsaved changes — click Save to keep them.'
                  : savedInputs.updatedAt
                    ? `Saved ${new Date(savedInputs.updatedAt).toLocaleString()}${savedInputs.updatedBy ? ` by ${savedInputs.updatedBy}` : ''}`
                    : 'Not yet saved for this year.'}
          </span>
          <button
            onClick={saveInputs}
            disabled={loadingInputs || saveState === 'saving' || (!dirty && saveState !== 'error')}
            className="px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveState === 'saving' ? 'Saving…' : 'Save inputs'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>}

      {diag?.partialYear && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-4 py-3 text-sm">
          <strong>CY{period} is still in progress.</strong> Only {diag.monthsCovered.length} month(s) of data are in the
          feed ({diag.monthsCovered.join(', ') || 'none'}). The annual SLS-450 is filed after the year closes (due Jan
          20, {Number(period) + 1}) — these figures are a running total, not the final return.
        </div>
      )}

      {boxes && diag && (
        <>
          <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg}`}>
            <table className="w-full text-sm">
              <tbody>
                {[
                  { line: 'Line 1', label: 'Gross Sales', value: boxes.grossSales, big: true },
                  { line: '', label: 'Exempt / Deductions', value: boxes.exemptSales, big: true },
                  { line: '', label: 'Taxable Sales', value: boxes.taxableSales },
                  { line: '', label: 'Taxable Purchases (use tax)', value: boxes.taxablePurchases },
                  { line: '', label: `State Tax (${(boxes.stateTaxRate * 100).toFixed(2)}%)`, value: boxes.stateTaxDue },
                  { line: '', label: `Local Tax (${(boxes.localTaxRate * 100).toFixed(2)}%)`, value: boxes.localTaxDue },
                  { line: '', label: 'Total Tax Due', value: boxes.totalTaxDue, highlight: true },
                ].map((r, idx) => (
                  <tr key={idx} className={`border-t ${rowBorder} first:border-t-0`}>
                    <td className="px-5 py-3 font-mono text-xs w-20">{r.line}</td>
                    <td className="px-2 py-3">{r.label}</td>
                    <td
                      className={`px-5 py-3 text-right tabular-nums ${r.highlight ? 'font-bold' : ''} ${r.big ? 'text-base' : ''}`}
                      style={r.highlight ? { color: '#5e3b8d' } : undefined}
                    >
                      {usd.format(r.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`rounded-xl shadow-sm p-5 ${cardBg} space-y-3`}>
            <p className="text-sm font-semibold">How these were derived</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
              <Row label="TN transactions" value={diag.totalTransactions.toLocaleString()} sub={subText} />
              <Row label="Taxable transactions" value={diag.taxableTransactions.toLocaleString()} sub={subText} />
              <Row label="Gross Sales (Σ Subtotal)" value={usd.format(boxes.grossSales)} sub={subText} />
              <Row label={`Taxable (Σ Tax ÷ ${(diag.combinedRate * 100).toFixed(2)}%)`} value={usd.format(boxes.taxableSales)} sub={subText} />
              <Row label="Tax collected (= total tax)" value={usd.format(diag.summedTaxCollected)} sub={subText} />
              <Row label="Months in feed" value={diag.monthsCovered.join(', ') || 'none'} sub={subText} />
            </div>
            <p className={`text-xs ${subText}`}>
              Because Taxable = Σ Tax ÷ 9.25%, the computed State + Local tax equals the tax actually collected — no
              over/under-remittance. Chattanooga is in Hamilton County (2.25% local → 9.25% combined).
            </p>
          </div>

          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <h2 className="text-sm font-semibold">How to file — Tennessee SLS-450 (TNTAP)</h2>
              <a
                href={TNTAP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700"
              >
                Open Tennessee TNTAP ↗
              </a>
            </div>

            <div className={`text-xs mb-4 rounded-lg border px-3 py-2 ${rowBorder}`}>
              <span className="font-semibold">TNTAP login</span> — User: <code className="font-semibold">{TNTAP_LOGIN}</code>{' '}
              · Password: <code className="font-semibold">{TNTAP_PASSWORD}</code> · Account{' '}
              <code className="font-semibold">{TN_ACCOUNT}</code> (MEDROCK TN LLC)
            </div>

            <div className="space-y-4 text-sm">
              <div>
                <p className="font-semibold mb-1">1 · Prep (automated)</p>
                <ul className={`list-disc ml-5 space-y-1 ${subText}`}>
                  <li>Pick the <strong>filing year</strong> above — TN sales pull straight from the LifeFile feed.</li>
                  <li>Enter <strong>Taxable purchases</strong> (use tax from QuickBooks — usually 0).</li>
                  <li><strong>Save</strong> your inputs, then <strong>export the PDF/XLSX</strong> for documentation.</li>
                </ul>
              </div>

              <div>
                <p className="font-semibold mb-1">2 · File on TNTAP</p>
                <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
                  <li>Log in to TNTAP (button above).</li>
                  <li>Open <strong>Sales &amp; Use Tax</strong> → <strong>View/File Returns</strong> → the period ending 12/31/{period} → <strong>File</strong>.</li>
                  <li>Enter the values below; TNTAP computes the 7% state and 2.25% local tax.</li>
                </ol>
              </div>

              <div>
                <p className="font-semibold mb-1">3 · Enter the figures</p>
                <div className={`rounded-lg border overflow-hidden ${rowBorder}`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`border-b ${rowBorder} ${subText}`}>
                        <th className="text-left px-3 py-2">SLS-450 field</th>
                        <th className="text-right px-3 py-2 w-36">Enter</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {[
                        { item: 'Gross Sales (Line 1)', val: usd.format(boxes.grossSales) },
                        { item: 'Exempt / Deductions', val: usd.format(boxes.exemptSales) },
                        { item: 'Taxable Sales', val: usd.format(boxes.taxableSales) },
                        { item: 'Taxable Purchases (use tax)', val: usd.format(boxes.taxablePurchases) },
                      ].map((r) => (
                        <tr key={r.item} className={`border-t ${rowBorder} first:border-t-0`}>
                          <td className="px-3 py-1.5">{r.item}</td>
                          <td className="px-3 py-1.5 text-right font-medium">{r.val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className={`mt-2 ${subText}`}>
                  Verify TNTAP&apos;s computed tax: State <strong>{usd.format(boxes.stateTaxDue)}</strong> + Local{' '}
                  <strong>{usd.format(boxes.localTaxDue)}</strong> = <strong>{usd.format(boxes.totalTaxDue)}</strong>.
                </p>
              </div>

              <div>
                <p className="font-semibold mb-1">4 · Submit &amp; pay</p>
                <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
                  <li>File by <strong>Jan 20, {Number(period) + 1}</strong> (prior business day if a weekend/holiday).</li>
                  <li>Pay any balance due, then save/print the confirmation (e.g. <code>{period} - MedRock TN SLS-450 Confirmation</code>).</li>
                </ol>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  sub,
  affects,
  children,
}: {
  label: string;
  hint: string;
  sub: string;
  affects?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={`text-xs uppercase tracking-wide flex items-center gap-2 ${sub}`}>
        {label}
        {affects && (
          <span className="normal-case tracking-normal px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-semibold">
            → {affects}
          </span>
        )}
      </span>
      {children}
      <span className={`text-[11px] ${sub}`} dangerouslySetInnerHTML={{ __html: hint }} />
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
