'use client';

import { Fragment, useCallback, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { DriftMonthRow, DriftReport } from '@/lib/inventory/close-drift-server';
import type { DriftStatus } from '@/lib/inventory/close-drift';

const usd = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_LABEL: Record<DriftStatus, string> = {
  ties: 'Ties to FIFO',
  correct: 'Correct this month next',
  after: 'Waits for an earlier month',
  open: 'Correction draft open',
};

/**
 * Posted months — drift check (ds-close-drift-guard-2026-09-18).
 *
 * Every posted close trues the books to FIFO at the moment it posts; bills keyed later for
 * that month (or earlier ones) put the book back above FIFO. This reads, for every posted
 * month, how far it has moved and why — late QuickBooks entries vs FIFO itself moving — and
 * points at the ONE month to correct next. Corrections go oldest-first because month-end
 * balances carry forward; the server enforces that too.
 *
 * Loaded on demand: it reads one balance sheet per posted month per company.
 */
export function CloseDriftPanel({
  darkMode,
  onOpenMonth,
}: {
  darkMode: boolean;
  /** Jump the close tab to a month, where the posted receipt carries "Generate correction". */
  onOpenMonth: (month: string) => void;
}) {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory/monthly-close/drift');
      const raw = await res.text();
      let body: DriftReport & { error?: string };
      try {
        body = JSON.parse(raw) as DriftReport & { error?: string };
      } catch {
        throw new Error(`The drift check did not return data (HTTP ${res.status}) — usually a timeout; run it again.`);
      }
      if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Drift check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const badge = (s: DriftStatus): string => {
    if (s === 'ties') return darkMode ? 'bg-emerald-900/60 text-emerald-200' : 'bg-emerald-100 text-emerald-800';
    if (s === 'correct') return darkMode ? 'bg-amber-900/60 text-amber-200' : 'bg-amber-100 text-amber-800';
    if (s === 'open') return darkMode ? 'bg-blue-900/60 text-blue-200' : 'bg-blue-100 text-blue-800';
    return darkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600';
  };

  const byEntity = new Map<string, DriftMonthRow[]>();
  for (const r of report?.months ?? []) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);

  return (
    <div className={`rounded-xl shadow-sm border ${border} ${cardBg} p-4 space-y-3`}>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="font-semibold">Posted months: drift check</h3>
          <p className={`text-xs ${subText}`}>
            How far each posted close has moved from FIFO since it posted, and why. Correct the highlighted
            month first; later months wait because month-end balances carry forward.
          </p>
        </div>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
          {loading ? 'Checking…' : report ? 'Re-run drift check' : 'Run drift check'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {report && report.months.length === 0 && <p className={`text-sm ${subText}`}>No posted monthly closes yet.</p>}

      {[...byEntity.entries()].map(([entity, rows]) => (
        <div key={entity} className="overflow-x-auto">
          <p className="text-sm font-medium mb-1">{entity}</p>
          <table className="w-full text-sm">
            <thead className={subText}>
              <tr className="text-left">
                <th className="py-1 pr-3">Month</th>
                <th className="py-1 pr-3">Posted</th>
                <th className="py-1 pr-3 text-right" title="FIFO − book now: what a correction would book">Gap now</th>
                <th className="py-1 pr-3 text-right" title="QuickBooks entries dated in or before the month, keyed after it posted">Keyed late</th>
                <th className="py-1 pr-3 text-right" title="The FIFO value itself changed since posting">FIFO moved</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = `${r.entity}|${r.month}`;
                return (
                  <Fragment key={key}>
                    <tr className={`border-t ${border}`}>
                      <td className="py-1 pr-3 whitespace-nowrap">{r.month}</td>
                      <td className={`py-1 pr-3 text-xs ${subText}`}>{r.postedDocs.join(', ')}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.unavailable ? 'n/a' : usd(r.gap)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.unavailable ? '' : usd(r.late)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.unavailable ? '' : usd(r.fifoMoved)}</td>
                      <td className="py-1 pr-3">
                        {r.unavailable ? (
                          <span className={`text-xs ${subText}`}>Book unavailable</span>
                        ) : (
                          <span className={`text-xs px-2 py-0.5 rounded-full ${badge(r.status)}`} title={r.blockedBy ?? undefined}>
                            {STATUS_LABEL[r.status]}
                          </span>
                        )}
                      </td>
                      <td className="py-1 whitespace-nowrap text-right">
                        {(r.lateEntries.length > 0 || r.editedDocs > 0) && (
                          <button
                            onClick={() => setExpanded(expanded === key ? null : key)}
                            className="text-xs underline mr-3"
                          >
                            {expanded === key ? 'Hide detail' : 'Detail'}
                          </button>
                        )}
                        {(r.status === 'correct' || r.status === 'open') && (
                          <button onClick={() => onOpenMonth(r.month)} className="text-xs font-medium text-blue-600 underline">
                            Open {r.month}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === key && (
                      <tr>
                        <td colSpan={7} className={`pb-3 text-xs ${subText}`}>
                          <div className="pl-3 space-y-1">
                            {r.categories
                              .filter((c) => Math.abs(c.gap) >= 0.01 || Math.abs(c.late) >= 0.01)
                              .map((c) => (
                                <p key={c.category}>
                                  {c.category}: gap {usd(c.gap)} · keyed late {usd(c.late)} · FIFO moved {usd(c.fifoMoved)}
                                  {c.editedDocs > 0 ? ` · ${c.editedDocs} older document(s) edited since posting` : ''}
                                </p>
                              ))}
                            {r.lateEntries.length > 0 && <p className="pt-1 font-medium">Largest entries keyed after {r.month} posted:</p>}
                            {r.lateEntries.map((t) => (
                              <p key={`${t.type}-${t.docId}-${t.account}`}>
                                {t.txnDate} · {t.type} {t.docNumber} · {t.name} · {t.account.split(':').pop()} ·{' '}
                                <span className="tabular-nums">{usd(t.amount)}</span> · keyed{' '}
                                {new Date(t.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              </p>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {report && (
        <p className={`text-xs ${subText}`}>
          Checked {new Date(report.asOf).toLocaleString()}. &ldquo;Keyed late&rdquo; is usually bills entered after the close
          posted; correct once the month&rsquo;s bills are in, or it will drift again. &ldquo;FIFO moved&rdquo; means the
          valuation itself changed. Check that before correcting.
        </p>
      )}
    </div>
  );
}
