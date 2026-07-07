'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import CopyValue from '@/components/CopyValue';
import type { TxReturnResponse } from '@/types/sales-tax';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Texas Comptroller eSystems / WebFile portal (shared login; pick the taxpayer account inside).
const TX_PORTAL_URL = 'https://security.app.cpa.state.tx.us/';
const TX_PORTAL_LOGIN = 'MedrockFlorida';
const TX_PORTAL_PASSWORD = 'MedRock2024$';

interface SavedInputs {
  taxablePurchases: number | null;
  salesBasisOverride: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Per-return display config (which eSystems account to open, single-rate note). */
interface TxUiConfig {
  taxpayerId: string;
  accountName: string;
  /** True for the remote-seller entity that files the single local use tax rate. */
  singleRate: boolean;
}
const TX_UI: Record<string, TxUiConfig> = {
  'florida/tx': { taxpayerId: '32089108859', accountName: 'MEDROCK PHARMACY LLC', singleRate: true },
  'texas/tx': { taxpayerId: '32087811041', accountName: 'MEDROCK TEXAS PHARMACY LLC', singleRate: false },
};

const FILING_PERIODS: string[] = (() => {
  const out: string[] = [];
  for (let y = 2026; y <= 2027; y++) for (let q = 1; q <= 4; q++) out.push(`${y}-Q${q}`);
  return out;
})();

/** The quarter that has most recently ended (the one you file now). */
function lastCompletedQuarter(): string {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1; // current quarter (1-4)
  if (q === 1) return `${d.getFullYear() - 1}-Q4`;
  return `${d.getFullYear()}-Q${q - 1}`;
}
function currentQuarter(): string {
  const d = new Date();
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

export default function SalesTaxTX({ slug }: { slug: string }) {
  const { darkMode } = useDarkMode();
  const ui = TX_UI[slug];

  const lastQ = lastCompletedQuarter();
  const curQ = currentQuarter();
  const [period, setPeriod] = useState(() => (FILING_PERIODS.includes(lastQ) ? lastQ : '2026-Q1'));
  const [taxablePurchases, setTaxablePurchases] = useState('0');
  const [data, setData] = useState<TxReturnResponse | null>(null);
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
    const p = new URLSearchParams({ slug, period });
    if (taxablePurchases && Number(taxablePurchases) !== 0) p.set('taxablePurchases', taxablePurchases);
    return p.toString();
  }, [slug, period, taxablePurchases]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sales-tax/tx?${query}`)
      .then((r) => r.json() as Promise<TxReturnResponse | { error: string }>)
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

  // Load saved inputs when the period changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingInputs(true);
    setSaveState('idle');
    fetch(`/api/sales-tax/inputs?slug=${encodeURIComponent(slug)}&month=${period}`)
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
  }, [slug, period]);

  const parsedTP = taxablePurchases.trim() === '' ? 0 : Number(taxablePurchases);
  const dirty = parsedTP !== (savedInputs.taxablePurchases ?? 0);

  const saveInputs = useCallback(async () => {
    setSaveState('saving');
    try {
      const resp = await fetch('/api/sales-tax/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, month: period, taxablePurchases: parsedTP, salesBasisOverride: null }),
      });
      const d = (await resp.json()) as { ok?: boolean; updatedAt?: string | null; updatedBy?: string | null; error?: string };
      if (!resp.ok || !d.ok) throw new Error(d.error || 'save failed');
      setSavedInputs({ taxablePurchases: parsedTP, salesBasisOverride: null, updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null });
      setSaveState('idle');
    } catch {
      setSaveState('error');
    }
  }, [slug, period, parsedTP]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm w-full ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const exportHref = useCallback((fmt: 'csv' | 'pdf' | 'xlsx') => `/api/sales-tax/tx?${query}&format=${fmt}`, [query]);

  const boxes = data?.boxes;
  const diag = data?.diagnostics;

  if (!ui) {
    return <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">Unknown Texas return: {slug}</div>;
  }

  return (
    <div className="space-y-6">
      <p className={`text-sm ${subText}`}>
        Generated from the LifeFile feed. Taxable Sales uses the per-transaction backout (tax ÷ combined rate, capped at
        the order subtotal) — the same method as the FL DR-15, which isolates the taxable portion of partially-exempt Rx
        orders.{data?.feedAsOf ? ` Feed as of ${new Date(data.feedAsOf).toLocaleDateString()}.` : ''}
      </p>

      {/* Controls */}
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          <Field label="Filing quarter" hint="Defaults to the last completed quarter — the one you file now." sub={subText}>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputCls}>
              {FILING_PERIODS.map((p) => {
                const isLast = p === lastQ;
                const isCurrent = p === curQ;
                const label = isLast ? `${p}  ◀ file now` : isCurrent ? `${p}  — current (in progress)` : p;
                return (
                  <option
                    key={p}
                    value={p}
                    style={isLast ? { fontWeight: 700, backgroundColor: '#ede9fe', color: '#5b21b6' } : undefined}
                  >
                    {label}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field
            label="Taxable purchases"
            affects="Item 3"
            hint="Use tax from QuickBooks — usually 0. Adds to the amount subject to state &amp; local tax."
            sub={subText}
          >
            <input
              type="number"
              step="1"
              value={taxablePurchases}
              onChange={(e) => setTaxablePurchases(e.target.value)}
              className={inputCls}
              placeholder="0"
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
                    : 'Not yet saved for this quarter.'}
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

      {/* Single-rate election (FL remote-seller entity only) — CPA-approved 2026-06-17; now file 01-799 */}
      {ui.singleRate && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-4 py-3 text-sm space-y-1.5">
          <p>
            <strong>Single local use tax rate (1.75%) — CPA-approved; file Form 01-799 to elect it.</strong> These
            figures use the remote-seller single local rate (combined 8.00%).
          </p>
          <p>
            Email{' '}
            <a
              href="https://comptroller.texas.gov/forms/01-799.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold"
            >
              Form 01-799
            </a>{' '}
            to <code>sales.applications@cpa.texas.gov</code> (or mail to Comptroller of Public Accounts, P.O. Box
            149354, Austin, TX 78714-9354) for <strong>{ui.accountName}</strong> (taxpayer{' '}
            <code>{ui.taxpayerId}</code>), electing to <strong>use</strong> the single local use tax rate. Not filed
            through WebFile. The election is <strong>forward-only</strong> — effective the start of a reporting period,
            so file before the quarter you want it to apply to (earliest: the next quarter start). It stays in effect
            until you revoke it (same form).
          </p>
        </div>
      )}

      {boxes && diag && (
        <>
          {/* WebFile values */}
          <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg}`}>
            <table className="w-full text-sm">
              <tbody>
                {[
                  { line: 'Item 1', label: 'Total Texas Sales', value: boxes.totalTexasSales, dollars: true },
                  { line: 'Item 2', label: 'Taxable Sales', value: boxes.taxableSales, dollars: true },
                  { line: 'Item 3', label: 'Taxable Purchases', value: boxes.taxablePurchases, dollars: true },
                  { line: '', label: 'Amount Subject to State Tax', value: boxes.subjectToStateTax, dollars: true },
                  { line: '', label: `State Tax Due (${(boxes.stateTaxRate * 100).toFixed(4)}%)`, value: boxes.stateTaxDue },
                  { line: '', label: `Local Tax Due (${(boxes.combinedLocalRate * 100).toFixed(3)}%)`, value: boxes.totalLocalTaxDue },
                  { line: '', label: 'Total Tax Due', value: boxes.totalTaxDue, highlight: true },
                  { line: '', label: 'Timely Filing Discount (0.5%)', value: -boxes.timelyFilingDiscount },
                  { line: '', label: 'Net Tax Due', value: boxes.netTaxDue, highlight: true },
                ].map((r, idx) => (
                  <tr key={idx} className={`border-t ${rowBorder} first:border-t-0`}>
                    <td className="px-5 py-3 font-mono text-xs w-20">{r.line}</td>
                    <td className="px-2 py-3">{r.label}</td>
                    <td
                      className={`px-5 py-3 text-right tabular-nums ${r.highlight ? 'font-bold' : ''}`}
                      style={r.highlight ? { color: '#5e3b8d' } : undefined}
                    >
                      {r.dollars ? (
                        <CopyValue display={`$${whole.format(r.value)}`} copy={String(Math.round(r.value))} />
                      ) : (
                        <CopyValue display={usd.format(r.value)} copy={r.value.toFixed(2)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Local jurisdiction breakdown */}
          <div className={`rounded-xl shadow-sm p-5 ${cardBg} space-y-3`}>
            <p className="text-sm font-semibold">Local tax by jurisdiction</p>
            <p className={`text-xs ${subText}`}>
              {ui.singleRate
                ? 'Remote seller — one Single Local Use Tax Rate line every quarter (1.75%). The jurisdiction is fixed; only the amounts change by period.'
                : 'In-state seller — local tax is origin-sourced to the Colleyville place of business, so these two jurisdictions are the same every quarter (matching the filed return). Only the Subject / Local-tax amounts change by period.'}
            </p>
            <div className={`rounded-lg border overflow-hidden ${rowBorder}`}>
              <table className="w-full text-xs">
                <thead>
                  <tr className={`border-b ${rowBorder} ${subText}`}>
                    <th className="text-left px-3 py-2">Jurisdiction</th>
                    <th className="text-left px-3 py-2 w-28">Code</th>
                    <th className="text-right px-3 py-2 w-24">Rate</th>
                    <th className="text-right px-3 py-2 w-28">Subject</th>
                    <th className="text-right px-3 py-2 w-24">Local tax</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {boxes.localLines.map((l, i) => (
                    <tr key={i} className={`border-t ${rowBorder} first:border-t-0`}>
                      <td className="px-3 py-1.5">{l.name}</td>
                      <td className="px-3 py-1.5 font-mono">{l.code || '—'}</td>
                      <td className="px-3 py-1.5 text-right">{(l.rate * 100).toFixed(3)}%</td>
                      <td className="px-3 py-1.5 text-right">
                        <CopyValue
                          display={`$${whole.format(l.amountSubjectToLocal)}`}
                          copy={String(Math.round(l.amountSubjectToLocal))}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <CopyValue display={usd.format(l.localTaxDue)} copy={l.localTaxDue.toFixed(2)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
              <Row label="TX transactions" value={diag.totalTransactions.toLocaleString()} sub={subText} />
              <Row label="Taxable transactions" value={diag.taxableTransactions.toLocaleString()} sub={subText} />
              <Row label="Summed Subtotal (Item 1 basis)" value={usd.format(diag.summedSubtotalExact)} sub={subText} />
              <Row label={`Taxable base (backout @ ${(diag.combinedRate * 100).toFixed(2)}%)`} value={usd.format(diag.taxableBaseExact)} sub={subText} />
              <Row label="Tax collected by LifeFile" value={usd.format(diag.summedTaxCollected)} sub={subText} />
              <Row label="Months covered" value={diag.monthsCovered.join(', ') || 'none'} sub={subText} />
            </div>
            <p className={`text-xs ${subText}`}>
              Permit-start floor {diag.permitStart}: pre-Feb-2026 Texas sales are excluded (both permits went effective
              Feb 2026). Total Texas Sales and Taxable Sales are whole dollars (Texas WebFile convention).
              {diag.taxableDestinations.length > 0 && (
                <>
                  {' '}Taxable orders shipped to:{' '}
                  {diag.taxableDestinations.map((t) => `${t.county.replace(' County', '')} (${t.transactions})`).join(', ')}.
                </>
              )}
            </p>
          </div>

          {/* How to file */}
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <h2 className="text-sm font-semibold">How to file — Texas Sales &amp; Use Tax (WebFile / 01-114)</h2>
              <a
                href={TX_PORTAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700"
              >
                Open Texas Comptroller eSystems ↗
              </a>
            </div>

            <div className={`text-xs mb-4 rounded-lg border px-3 py-2 ${rowBorder}`}>
              <span className="font-semibold">eSystems login</span> (shared — pick the account inside) — User:{' '}
              <CopyValue display={TX_PORTAL_LOGIN} copy={TX_PORTAL_LOGIN} mono /> · Password:{' '}
              <CopyValue display={TX_PORTAL_PASSWORD} copy={TX_PORTAL_PASSWORD} mono />
            </div>

            <div className="space-y-4 text-sm">
              <div>
                <p className="font-semibold mb-1">1 · Prep (automated)</p>
                <ul className={`list-disc ml-5 space-y-1 ${subText}`}>
                  <li>Pick the <strong>filing quarter</strong> above — Texas sales pull straight from the LifeFile feed.</li>
                  <li>Enter <strong>Taxable purchases</strong> (use tax from QuickBooks — usually 0).</li>
                  <li><strong>Save</strong> your inputs, then <strong>export the PDF/XLSX</strong> for documentation.</li>
                </ul>
              </div>

              <div>
                <p className="font-semibold mb-1">2 · Start the return</p>
                <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
                  <li>Log in to eSystems (button above).</li>
                  <li>
                    On <strong>My Taxpayer Accounts</strong>, open the row{' '}
                    <strong>{ui.accountName}</strong> · <strong>Sales and Use Tax</strong> (Taxpayer{' '}
                    <CopyValue display={ui.taxpayerId} copy={ui.taxpayerId} mono />).
                  </li>
                  <li>
                    Choose <strong>WebFile/Pay Taxes and Fees</strong> → <strong>File an Original Return</strong> → select
                    the period, then continue past the credit questions (all <strong>No</strong>).
                  </li>
                </ol>
              </div>

              <div>
                <p className="font-semibold mb-1">3 · Enter the figures (whole dollars)</p>
                <div className={`rounded-lg border overflow-hidden ${rowBorder}`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`border-b ${rowBorder} ${subText}`}>
                        <th className="text-left px-3 py-2">WebFile field</th>
                        <th className="text-right px-3 py-2 w-32">Enter</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {[
                        { item: 'Total Texas Sales', num: boxes.totalTexasSales },
                        { item: 'Taxable Sales', num: boxes.taxableSales },
                        { item: 'Taxable Purchases', num: boxes.taxablePurchases },
                      ].map((r) => (
                        <tr key={r.item} className={`border-t ${rowBorder} first:border-t-0`}>
                          <td className="px-3 py-1.5">{r.item}</td>
                          <td className="px-3 py-1.5 text-right font-medium">
                            <CopyValue display={`$${whole.format(r.num)}`} copy={String(Math.round(r.num))} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className={`mt-2 ${subText}`}>
                  {ui.singleRate ? (
                    <>
                      Then for local tax, add the <strong>Single Local Use Tax Rate</strong> jurisdiction (per the 01-799
                      election) with{' '}
                      <strong>
                        <CopyValue
                          display={`$${whole.format(boxes.subjectToStateTax)}`}
                          copy={String(Math.round(boxes.subjectToStateTax))}
                        />
                      </strong>{' '}
                      subject to local tax.
                    </>
                  ) : (
                    <>
                      Then add the Colleyville jurisdiction lines below (the place of business — origin-sourced), each
                      with{' '}
                      <strong>
                        <CopyValue
                          display={`$${whole.format(boxes.subjectToStateTax)}`}
                          copy={String(Math.round(boxes.subjectToStateTax))}
                        />
                      </strong>{' '}
                      subject to local tax:
                    </>
                  )}
                </p>
                {!ui.singleRate && (
                  <ul className={`list-disc ml-5 mt-1 space-y-0.5 ${subText}`}>
                    {boxes.localLines.map((l, i) => (
                      <li key={i}>
                        <strong>{l.name}</strong> (<CopyValue display={l.code} copy={l.code} mono />) —{' '}
                        {(l.rate * 100).toFixed(3)}%
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="font-semibold mb-1">4 · Review, pay &amp; submit</p>
                <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
                  <li>
                    WebFile computes State Tax, Local Tax, the <strong>0.5% timely-filing discount</strong>, and Net Tax
                    Due — confirm they match: State <strong>{usd.format(boxes.stateTaxDue)}</strong>, Local{' '}
                    <strong>{usd.format(boxes.totalLocalTaxDue)}</strong>, Net{' '}
                    <strong>{usd.format(boxes.netTaxDue)}</strong>.
                  </li>
                  <li>
                    File the return with payment by <strong>the 20th of the month after the quarter ends</strong> (prior
                    business day if a weekend/holiday). Pay by electronic check from the operating account.
                  </li>
                  <li>Save/print the PDF confirmation (e.g. <code>{period.replace('-', '')} - MedRock {ui.accountName.includes('TEXAS') ? 'TX' : 'FL'} 01-114 Confirmation</code>).</li>
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
