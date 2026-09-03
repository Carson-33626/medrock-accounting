'use client';

import { useEffect, useState } from 'react';
import HelpTip from './HelpTip';
import { shortInventoryLocation } from '@/lib/inventory/monthly-close';
import type { LabSuppliesAccrualResponse } from '@/app/api/inventory/lab-supplies-accrual/route';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The explanation shown behind the "?" — this is the only place most people will
 * ever read how the number was arrived at, so it has to stand on its own.
 */
const METHOD = [
  'Lab supplies (gloves, gowns, masks, bleach) are bought ad hoc and almost never received into ',
  'LifeFile, so FIFO has nothing to deplete — it sees under 1.5% of what is actually spent. The ',
  'category was removed from inventory entirely and this accrues the cost instead.',
  '\n\n',
  'Each month: accrual = (1 − completeness) × the location’s historical monthly average. So a ',
  'month nobody has entered yet accrues the full average, and the accrual shrinks to nothing as ',
  'the real bills arrive — it reverses itself rather than standing as a permanent estimate.',
  '\n\n',
  'Completeness is the LOWER of two measures: (1) how complete a month this old usually is, from ',
  'a curve fitted on months old enough to have settled; and (2) how many documents have actually ',
  'been entered, against that location’s normal monthly count. The second exists because the ',
  'first assumes normal data entry. In April and May 2026 entry ran 120+ days late instead of the ',
  'usual 1–2, and that backfill is still running — on elapsed days alone June looks finished, but ',
  'only a fraction of its documents are keyed, so the document measure is what governs.',
  '\n\n',
  'Purchase timing itself was tested and rejected as a predictor: bills arrive every 1.7–2.8 days ',
  'in bursts (variability ≥ 1), and order size has essentially no relationship to the gap before ',
  'it. How much of a month has arrived is the signal; when the last one arrived is not.',
].join('');

/**
 * Lab-supplies accrual, per location, for the recent months.
 *
 * Fetches on mount rather than taking data through props: it reads QuickBooks
 * live, not the FIFO ledger the rest of this page is built on, and it is the only
 * consumer. A failure here shows a line of text and leaves the rest of the tab
 * alone — this is supplementary to COGS, not part of it.
 */
export default function LabSuppliesAccrual({
  cardBg,
  rowBorder,
  subText,
  darkMode,
}: {
  cardBg: string;
  rowBorder: string;
  subText: string;
  darkMode: boolean;
}) {
  const [data, setData] = useState<LabSuppliesAccrualResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    fetch('/api/inventory/lab-supplies-accrual')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: LabSuppliesAccrualResponse) => {
        if (live) setData(d);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Failed to load the accrual');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const th = `px-2 py-1 text-left font-medium ${subText}`;
  const cell = 'px-2 py-1 text-right tabular-nums';

  return (
    <div className={`rounded-xl shadow-sm p-5 mt-4 ${cardBg}`}>
      <p className="text-sm font-semibold flex items-center gap-1.5">
        Lab supplies — accrued, not received
        <HelpTip label="How this is calculated" text={METHOD} />
      </p>
      <p className={`text-xs mt-1 ${subText}`}>
        This category was cleared out of FIFO because the purchasing never routes through LifeFile.
        These are the accrual amounts that replace it — posted as{' '}
        <span className="font-medium">Dr 5000.25 Lab Supplies / Cr 1220.20 Lab Supplies Inventory</span>.
      </p>

      {loading && <p className={`text-xs mt-3 ${subText}`}>Reading QuickBooks…</p>}
      {error !== null && <p className="text-xs mt-3 text-red-600">{error}</p>}

      {data !== null && (
        <>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs">
              <thead>
                <tr className={`border-b ${rowBorder}`}>
                  <th className={th}>Location</th>
                  <th className={th}>Month</th>
                  <th className={`${th} text-right`}>Entered so far</th>
                  <th className={`${th} text-right`}>Docs</th>
                  <th className={`${th} text-right`}>Complete</th>
                  <th className={`${th} text-right`}>Accrual</th>
                  <th className={`${th} text-right`}>Estimated total</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={`${m.location}|${m.month}`} className={`border-b last:border-0 ${rowBorder}`}>
                    <td className="px-2 py-1 font-medium">{shortInventoryLocation(m.location)}</td>
                    <td className="px-2 py-1">{m.month}</td>
                    <td className={`${cell} ${subText}`}>{usd.format(m.observedToDate)}</td>
                    <td className={`${cell} ${subText}`}>{m.observedDocs}</td>
                    <td className={cell}>
                      {pct(m.completeness)}
                      {m.boundBy === 'entry' && (
                        <span
                          title="Bound by documents entered, not elapsed time — data entry for this month is behind, so the age-based curve would overstate how finished it is."
                          className="ml-1 text-[9px] px-1 rounded bg-amber-500/20 text-amber-600 font-semibold uppercase cursor-help"
                        >
                          entry
                        </span>
                      )}
                    </td>
                    <td className={`${cell} font-medium`}>{usd.format(m.accrual)}</td>
                    <td className={cell}>
                      {usd.format(m.estimatedTotal)}
                      {m.flagged && (
                        <span
                          title={m.flagReason ?? ''}
                          className="ml-1 text-[9px] px-1 rounded bg-red-500/20 text-red-600 font-semibold uppercase cursor-help"
                        >
                          review
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.months.some((m) => m.borrowedCurve) && (
            <p className={`text-[11px] mt-2 ${subText}`}>
              Texas has no settled months of its own yet, so it borrows the pooled Florida +
              Tennessee completeness curve and a five-month average. Treat its figures as
              indicative until it has a full year — around January 2027.
            </p>
          )}
          {data.months.some((m) => m.flagged) && (
            <p className={`text-[11px] mt-1 ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}>
              Months marked <span className="font-semibold">review</span> estimate below half the
              historical average. Check them against QuickBooks before posting rather than taking
              the number as read.
            </p>
          )}
          {data.unavailable.length > 0 && (
            <p className={`text-[11px] mt-1 ${subText}`}>
              Not read: {data.unavailable.join('; ')}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
