'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { CLOSE_STATUS_LABEL } from '@/lib/inventory/monthly-close';
import type {
  LabAccrualHeader,
  LabAccrualLine,
  LabSuppliesAccrualMonth,
} from '@/lib/inventory/lab-supplies-server';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface ApiErrorBody {
  error?: string;
}

interface LabAccrualResponse extends ApiErrorBody {
  month: string;
  headers: LabAccrualHeader[];
  linesById: Record<string, LabAccrualLine[]>;
  estimate: LabSuppliesAccrualMonth[];
  unavailable: string[];
  skipped?: string[];
}

/**
 * The lab-supplies accrual, on the Inventory Close tab.
 *
 * Carson, 2026-09-03: *"i want to add this on the COGS/Inventory journal entries so
 * that this piece becomes visible and they can use the inventory JE to post this."*
 * It is inventory cost by nature and the accountants work the close from one screen,
 * so it gets the same Generate → Approve → Dry run → Post workflow and the same
 * handlers as the close drafts themselves.
 *
 * BOTH halves of every pair are shown. The reversal is dated the first of the
 * following month and is its own posting act — showing only the accrual would leave
 * a liability on screen with nothing saying it comes back off.
 */
export default function LabAccrualCard({
  month,
  darkMode,
  busyHeaderId,
  onApprove,
  onDryRun,
  onPostLive,
  refreshKey,
}: {
  month: string;
  darkMode: boolean;
  busyHeaderId: number | null;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
  /** Bumped by the parent after a post, so the card re-reads its own drafts. */
  refreshKey: number;
}) {
  const [data, setData] = useState<LabAccrualResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inventory/lab-supplies-accrual/generate?month=${month}`);
      const body = (await res.json()) as LabAccrualResponse;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read the lab-supplies accrual');
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory/lab-supplies-accrual/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      });
      const body = (await res.json()) as LabAccrualResponse;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate the lab-supplies accrual');
    } finally {
      setGenerating(false);
    }
  }, [month]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const thCls = `text-left font-medium py-1 pr-4 ${subText}`;
  const numCls = 'py-1 pr-4 text-right tabular-nums';

  const headers = data?.headers ?? [];
  const estimate = data?.estimate ?? [];
  const estimateTotal = estimate.reduce((s, e) => s + e.accrual, 0);
  const anyPosted = headers.some((h) => h.status === 'posted');

  const statusChip = (h: LabAccrualHeader) => {
    const palette: Record<LabAccrualHeader['status'], string> = {
      draft: darkMode ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-700',
      needs_review: darkMode ? 'bg-amber-900/60 text-amber-200' : 'bg-amber-100 text-amber-800',
      approved: darkMode ? 'bg-blue-900/60 text-blue-200' : 'bg-blue-100 text-blue-800',
      posted: darkMode ? 'bg-emerald-900/60 text-emerald-200' : 'bg-emerald-100 text-emerald-800',
      error: darkMode ? 'bg-red-900/60 text-red-200' : 'bg-red-100 text-red-800',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${palette[h.status]}`}>
        {CLOSE_STATUS_LABEL[h.status]}
        {h.status === 'posted' && h.qb_doc_number ? ` · ${h.qb_doc_number}` : ''}
      </span>
    );
  };

  const btn = (label: string, onClick: () => void, disabled: boolean, primary = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        primary
          ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
          : darkMode
            ? 'border-slate-600 text-slate-200 hover:bg-slate-700'
            : 'border-slate-300 text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Lab supplies — accrual for {month}</p>
          <p className={`text-xs mt-1 max-w-3xl ${subText}`}>
            Lab supplies are bought ad hoc and never received into LifeFile, so FIFO has nothing to
            deplete — the category was cleared out of inventory and this accrues the cost instead.
            Posts <span className="font-medium">Dr 5000.25 Lab Supplies / Cr 2011 Accrued Expenses</span>,
            with a matching reversal on the first of the following month so the real bills are not
            counted twice when they arrive.
          </p>
        </div>
        {btn(
          generating ? 'Generating…' : headers.length > 0 ? 'Regenerate' : 'Generate drafts',
          () => void handleGenerate(),
          generating || anyPosted,
        )}
      </div>

      {error !== null && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            darkMode ? 'bg-red-950/40 border-red-900 text-red-200' : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      {estimate.length > 0 && (
        <p className={`text-xs mt-3 ${subText}`}>
          Current estimate:{' '}
          {estimate
            .map((e) => `${e.location.replace('MedRock ', '')} ${usd.format(e.accrual)}`)
            .join(' · ')}{' '}
          — total <span className="font-medium">{usd.format(estimateTotal)}</span>
          {estimate.some((e) => e.boundBy === 'entry') && ' (bound by documents keyed, not elapsed time)'}
        </p>
      )}

      {headers.length === 0 ? (
        <p className={`text-xs mt-3 ${subText}`}>
          No drafts for this month yet. Generate builds one accrual and one reversal per location
          that has something to accrue; a location whose month has settled produces nothing.
        </p>
      ) : (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className={`border-b ${border}`}>
                <th className={thCls}>Entity</th>
                <th className={thCls}>Entry</th>
                <th className={thCls}>Posts</th>
                <th className={`${thCls} text-right`}>Amount</th>
                <th className={thCls}>Status</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {headers.map((h) => {
                const busy = busyHeaderId === h.id;
                const label = `${h.entity} ${h.kind === 'reversal' ? 'reversal' : 'accrual'}`;
                return (
                  <tr key={h.id} className={`border-b last:border-0 ${border}`}>
                    <td className="py-1.5 pr-4 font-medium">{h.entity.replace('MedRock ', '')}</td>
                    <td className={`py-1.5 pr-4 ${h.kind === 'reversal' ? subText : ''}`}>
                      {h.kind === 'reversal' ? 'Reversal' : 'Accrual'}
                    </td>
                    <td className={`py-1.5 pr-4 ${subText}`}>{h.txn_date ?? '—'}</td>
                    <td className={numCls}>{usd.format(h.total_debits)}</td>
                    <td className="py-1.5 pr-4">{statusChip(h)}</td>
                    <td className="py-1.5 pr-4">
                      <div className="flex gap-1.5 justify-end">
                        {h.status === 'needs_review' &&
                          btn('Approve', () => onApprove(h.id), busy)}
                        {h.status === 'approved' && (
                          <>
                            {btn('Dry run', () => onDryRun(h.id), busy)}
                            {btn('Post', () => onPostLive(h.id, label), busy, true)}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(data?.skipped?.length ?? 0) > 0 && (
        <p className={`text-[11px] mt-2 ${subText}`}>{data?.skipped?.join('; ')}</p>
      )}
      {(data?.unavailable.length ?? 0) > 0 && (
        <p className={`text-[11px] mt-1 ${subText}`}>
          Not read from QuickBooks: {data?.unavailable.join('; ')}.
        </p>
      )}
    </div>
  );
}
