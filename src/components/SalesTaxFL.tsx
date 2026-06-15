'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import type { FlDr15Response } from '@/types/sales-tax';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// This page is the MedRock Florida -> FL return; saved inputs key off this slug.
const FILING_SLUG = 'florida/fl';

// Florida DOR file & pay portal (new portal, live as of 2025-12-01).
const FL_DOR_PORTAL_URL =
  'https://login.prd.floridarevenue.com/fdorextprd.onmicrosoft.com/B2C_1A_prd_signin_saml/generic/login?EntityId=https://portal.fl.revenuepremier.com/samlsps/rptp/';

interface SavedInputs {
  taxablePurchases: number | null;
  salesBasisOverride: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const FILING_MONTHS: string[] = (() => {
  const out: string[] = [];
  for (let y = 2026; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
})();

export default function SalesTaxFL() {
  const { darkMode } = useDarkMode();

  const [month, setMonth] = useState('2026-05');
  const [taxablePurchases, setTaxablePurchases] = useState('0');
  const [salesBasisOverride, setSalesBasisOverride] = useState('');
  const [data, setData] = useState<FlDr15Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persistence: last-saved snapshot for the current month + save status.
  const [savedInputs, setSavedInputs] = useState<SavedInputs>({
    taxablePurchases: null,
    salesBasisOverride: null,
    updatedAt: null,
    updatedBy: null,
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [loadingInputs, setLoadingInputs] = useState(false);

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

  // Load saved inputs whenever the month changes; populate the editable fields.
  useEffect(() => {
    let cancelled = false;
    setLoadingInputs(true);
    setSaveState('idle');
    fetch(`/api/sales-tax/inputs?slug=${encodeURIComponent(FILING_SLUG)}&month=${month}`)
      .then((r) => r.json() as Promise<SavedInputs | { error: string }>)
      .then((d) => {
        if (cancelled || 'error' in d) return;
        setSavedInputs(d);
        setTaxablePurchases(d.taxablePurchases != null ? String(d.taxablePurchases) : '0');
        setSalesBasisOverride(d.salesBasisOverride != null ? String(d.salesBasisOverride) : '');
      })
      .catch(() => {
        /* leave defaults on load failure */
      })
      .finally(() => {
        if (!cancelled) setLoadingInputs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  // Current parsed values + dirty check vs the saved snapshot.
  const parsedTP = taxablePurchases.trim() === '' ? 0 : Number(taxablePurchases);
  const parsedSBO = salesBasisOverride.trim() === '' ? null : Number(salesBasisOverride);
  const dirty = parsedTP !== (savedInputs.taxablePurchases ?? 0) || parsedSBO !== savedInputs.salesBasisOverride;

  const saveInputs = useCallback(async () => {
    setSaveState('saving');
    try {
      const resp = await fetch('/api/sales-tax/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: FILING_SLUG,
          month,
          taxablePurchases: parsedTP,
          salesBasisOverride: parsedSBO,
        }),
      });
      const d = (await resp.json()) as { ok?: boolean; updatedAt?: string | null; updatedBy?: string | null; error?: string };
      if (!resp.ok || !d.ok) throw new Error(d.error || 'save failed');
      setSavedInputs({
        taxablePurchases: parsedTP,
        salesBasisOverride: parsedSBO,
        updatedAt: d.updatedAt ?? null,
        updatedBy: d.updatedBy ?? null,
      });
      setSaveState('idle');
    } catch {
      setSaveState('error');
    }
  }, [month, parsedTP, parsedSBO]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputCls = `rounded-lg border px-3 py-2 text-sm w-full ${
    darkMode ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
  }`;

  const exportHref = useCallback((fmt: 'csv' | 'pdf' | 'xlsx') => `/api/sales-tax/fl?${query}&format=${fmt}`, [query]);

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
    <div className="space-y-6">
      {/* Method + freshness note (filing identity + due date live in the page header) */}
      <p className={`text-sm ${subText}`}>
        Generated from the LifeFile feed. Method matches the accountant&apos;s workbook; taxable base uses 2026 county
        surtax rates.
        {data?.feedAsOf ? ` Feed as of ${new Date(data.feedAsOf).toLocaleDateString()}.` : ''}
      </p>

      {/* Controls — aligned grid */}
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
          <Field label="Filing month" hint="&nbsp;" sub={subText}>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
              {FILING_MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Taxable purchases"
            affects="Box 3 · 4"
            hint="Use tax (E7) from QB — usually 0. Adds to Box 3 (taxable) &amp; Box 4 (tax due)."
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
          <Field
            label="Sales basis override"
            affects="Box 1 · 2"
            hint="Bank deposit (B4); blank = summed sales. Box 1 = basis − tax; Box 2 = Box 1 − Box 3."
            sub={subText}
          >
            <input
              type="number"
              step="0.01"
              value={salesBasisOverride}
              onChange={(e) => setSalesBasisOverride(e.target.value)}
              className={inputCls}
              placeholder="auto"
            />
          </Field>
          <Field label="Export (summary + source)" hint={loading ? 'loading…' : ' '} sub={subText}>
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

        {/* Persist the manual inputs (taxable purchases + sales-basis override) per month */}
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
                    : 'Not yet saved for this month.'}
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

      {error && (
        <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">{error}</div>
      )}

      {/* Dated reminder: county surtax rates are CY-specific; flag when filing past that year. */}
      {diag?.surtaxStale && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-4 py-3 text-sm">
          <strong>Surtax rates may be out of date.</strong> The county rates loaded are for{' '}
          <strong>CY{diag.surtaxTaxYear}</strong> (FL DR-15DSS), but you&apos;re filing for{' '}
          <strong>{month.slice(0, 4)}</strong>. Update <code>fl-surtax.ts</code> /{' '}
          <code>data/fl_county_surtax_rates.json</code> from the {month.slice(0, 4)} DR-15DSS
          (FL publishes it ~January) before relying on Box 3 and the discretionary surtax.
        </div>
      )}

      {boxes && inputs && diag && (
        <>
          <div className={`rounded-xl shadow-sm overflow-hidden ${cardBg}`}>
            <table className="w-full text-sm">
              <tbody>
                {BOX_ROWS.map((r) => (
                  <tr key={r.line} className={`border-t ${rowBorder} first:border-t-0`}>
                    <td className="px-5 py-3 font-mono text-xs w-20">{r.line}</td>
                    <td className="px-2 py-3">{r.label}</td>
                    <td
                      className={`px-5 py-3 text-right tabular-nums ${r.highlight ? 'font-bold' : ''} ${
                        r.big ? 'text-base' : ''
                      }`}
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
              <Row label="FL transactions" value={diag.totalTransactions.toLocaleString()} sub={subText} />
              <Row label="Taxable transactions" value={diag.taxableTransactions.toLocaleString()} sub={subText} />
              <Row
                label={`Sales basis (${inputs.salesBasisSource === 'sales_sum' ? 'summed sales' : 'manual'})`}
                value={usd.format(inputs.salesBasis)}
                sub={subText}
              />
              <Row label="Summed Total Sales" value={usd.format(diag.summedTotalSales)} sub={subText} />
              <Row label="Tax collected (F4)" value={usd.format(inputs.taxCollected)} sub={subText} />
              <Row label="Taxable sales (E4, county-rate)" value={usd.format(inputs.taxableSales)} sub={subText} />
              <Row label={`— vs flat ${(diag.flatRate * 100).toFixed(1)}%`} value={usd.format(diag.flatRateTaxableBase)} sub={subText} />
              <Row label="Use tax on purchases (F7)" value={usd.format(inputs.salesUseTax)} sub={subText} />
            </div>
            {diag.unknownCountyRows > 0 && (
              <p className="text-xs text-amber-600">
                {diag.unknownCountyRows} taxable transaction(s) had an unknown county — used the 1% default surtax.
                Review before filing.
              </p>
            )}
            <p className={`text-xs ${subText}`}>
              Sales basis is the summed FL Subtotal (= the bank-statement deposit to the penny for Apr 2026). Tax
              collected reproduces the accountant&apos;s figure exactly. Taxable base divides each sale&apos;s tax
              by its delivery county&apos;s 2026 rate (6% + surtax), correctly handling partially-taxable orders.
            </p>
          </div>
        </>
      )}

      {/* How to file — directions (legacy ops doc, updated for this automated tool) */}
      <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-semibold">How to file — Florida DR-15EZ</h2>
          <a
            href={FL_DOR_PORTAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700"
          >
            Open Florida DOR — File &amp; Pay ↗
          </a>
        </div>

        <div className={`text-xs mb-4 rounded-lg border px-3 py-2 ${rowBorder}`}>
          <span className="font-semibold">FL DOR portal login</span> (new portal, live 2025-12-01) —{' '}
          Login ID: <code className="font-semibold">AF1674280601</code> · Password:{' '}
          <code className="font-semibold">69019542</code>
        </div>

        <div className="space-y-4 text-sm">
          {/* Step 1 — prep */}
          <div>
            <p className="font-semibold mb-1">1 · Prep (automated)</p>
            <ul className={`list-disc ml-5 space-y-1 ${subText}`}>
              <li>
                Pick the <strong>filing month</strong> above — Florida sales pull straight from the LifeFile feed (no
                more manual CSV export or Excel workbook).
              </li>
              <li>Enter <strong>Taxable purchases</strong> (use tax from QuickBooks — usually 0).</li>
              <li>
                If the <strong>Truist</strong> statement&apos;s Deposits &amp; Credits total differs from the summed
                sales, enter it in <strong>Sales basis override</strong>.
              </li>
              <li>
                <strong>Save</strong> your inputs, then <strong>export the PDF/XLSX</strong> for documentation.
              </li>
            </ul>
          </div>

          {/* Step 2 — start the return */}
          <div>
            <p className="font-semibold mb-1">2 · Start the return</p>
            <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
              <li>Log in to the portal (button above).</li>
              <li>
                Top menu → <strong>Online Transaction</strong> → <strong>File a Tax Return / Report</strong>.
              </li>
              <li>
                On the <strong>File a Form</strong> screen set:
                <ul className="list-disc ml-5 mt-1 space-y-0.5">
                  <li>Name: <strong>MEDROCK PHARMACY LLC</strong></li>
                  <li>Account: <strong>Sales And Use Tax</strong></li>
                  <li>Account ID: Certificate <strong>62-8016742806-0</strong></li>
                  <li>Form Type: <strong>DR-15EZ</strong></li>
                  <li>Return Type: <strong>Original Return</strong></li>
                  <li>Filing Method: <strong>File Online</strong></li>
                  <li>Filing Period: the month you&apos;re filing (e.g. <strong>05/01/2026 – 05/31/2026</strong>)</li>
                </ul>
                Then click <strong>Next</strong>.
              </li>
            </ol>
          </div>

          {/* Step 3 — fill the DR-15EZ (live values) */}
          <div>
            <p className="font-semibold mb-1">3 · Fill the DR-15EZ — type these values</p>
            <div className={`rounded-lg border overflow-hidden ${rowBorder}`}>
              <table className="w-full text-xs">
                <thead>
                  <tr className={`border-b ${rowBorder} ${subText}`}>
                    <th className="text-left px-3 py-2 w-12">Line</th>
                    <th className="text-left px-3 py-2">DR-15EZ line item</th>
                    <th className="text-right px-3 py-2 w-32">Enter</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[
                    { ln: '1', item: 'Gross Sales', val: boxes ? usd.format(boxes.box1_gross) : '—' },
                    { ln: '2', item: 'Exempt Sales', val: boxes ? usd.format(boxes.box2_exempt) : '—' },
                    { ln: '3', item: 'Taxable Sales and Purchases', val: boxes ? usd.format(boxes.box3_taxable) : '—' },
                    { ln: '4', item: 'Total Tax Due', val: boxes ? usd.format(boxes.box4_tax) : '—' },
                    { ln: '5', item: 'Lawful Deductions', val: '0.00' },
                    { ln: '6', item: 'DOR Credit Memo(s)', val: '0.00' },
                    { ln: '8a', item: 'Collection Allowance', val: boxes ? usd.format(boxes.box8a_allowance) : '—' },
                    { ln: '8b', item: 'Penalty (on-time = 0)', val: '0.00' },
                    { ln: '8c', item: 'Interest (on-time = 0)', val: '0.00' },
                    { ln: 'B', item: 'Discretionary Sales Surtax Due', val: boxes ? usd.format(boxes.boxB_surtax) : '—' },
                  ].map((r) => (
                    <tr key={r.ln} className={`border-t ${rowBorder} first:border-t-0`}>
                      <td className="px-3 py-1.5 font-mono">{r.ln}</td>
                      <td className="px-3 py-1.5">{r.item}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{r.val}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className={`list-disc ml-5 mt-2 space-y-1 ${subText}`}>
              <li>
                Leave <strong>Line 7 (Net Tax Due)</strong> and <strong>Line 9 (Amount Due with Return)</strong> — they
                auto-fill when you click <strong>Calculate</strong>.
              </li>
              <li>
                Leave the <strong>&ldquo;Donate Allowance to the Education Enhancement Trust Fund&rdquo;</strong> box{' '}
                <strong>unchecked</strong>, and <strong>Line A</strong> blank (not needed — surtax is reported on Line B).
              </li>
              <li>
                Click <strong>Calculate</strong>, verify Net Tax Due / Amount Due, then <strong>Continue</strong>.
              </li>
            </ul>
          </div>

          {/* Step 4 — pay & submit */}
          <div>
            <p className="font-semibold mb-1">4 · Pay &amp; submit</p>
            <ol className={`list-decimal ml-5 space-y-1 ${subText}`}>
              <li>
                <strong>Submit payment</strong> — initiate by the business day before the 20th (the old note says by the
                19th; best practice the 15th to be safe). Use the checkbox to auto-pay from the <strong>Truist</strong>{' '}
                checking account.
              </li>
              <li>
                Review the full submission, <strong>submit</strong>, then save/print the PDF confirmation and name it
                (e.g. <code>YYYYMM - MedRock FL DR-15EZ Confirmation</code>).
              </li>
            </ol>
          </div>
        </div>
      </div>
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
  /** Which DR-15 box(es) this input drives, e.g. 'Box 1 · 2' — shown as a badge. */
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
