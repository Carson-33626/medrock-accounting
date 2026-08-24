'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from '@/components/Explainer';
import HelpTip from '@/components/HelpTip';
import RollForward from '@/components/RollForward';
import JournalEntryPanel, { type QbJournalEntryPayload } from '@/components/JournalEntryPanel';
import { monthDates } from '@/lib/inventory/month-dates';
import type {
  CloseBasis,
  MonthlyCloseResponse,
  RollbackResponse,
  RollbackValuationRow,
} from '@/types/inventory';

interface ApiErrorBody {
  error?: string;
}

interface GenerateResponse {
  warnings: string[];
}

interface PostResponse {
  mode: 'dry_run' | 'live';
  payload: QbJournalEntryPayload;
}

/**
 * Inventory month-end close: roll-forward + adjusting JE for a chosen month, on
 * the rollback dual-basis valuation, with the same Generate → Approve → Post
 * workflow as the other journal entries on this page.
 */
export function InventoryCloseTab() {
  const { darkMode } = useDarkMode();
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [closeBasis, setCloseBasis] = useState<CloseBasis>('floor');
  const [monthlyClose, setMonthlyClose] = useState<MonthlyCloseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [busyHeaderId, setBusyHeaderId] = useState<number | null>(null);
  const [dryRunPayloads, setDryRunPayloads] = useState<Record<number, QbJournalEntryPayload>>({});
  // Stale-response guard (mirrors EndOfMonthTab.load): a slow close fetch for a month the
  // user has since switched away from must not clobber the current month's data.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/rollback')
      .then((r) => r.json() as Promise<RollbackResponse | { error: string }>)
      .then((data) => {
        if (cancelled) return;
        if ('rows' in data) setRollbackRows(data.rows);
      })
      .catch(() => {
        // Non-fatal: the tab renders its empty state.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Newest first — the close is almost always run for the most recent month.
  const months = useMemo(() => {
    const set = new Set(rollbackRows.map((r) => r.as_of_month));
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rollbackRows]);

  const selectedMonth = month ?? months[0] ?? null;

  const loadClose = useCallback(async (m: string, basis: CloseBasis) => {
    const token = ++requestSeqRef.current;
    try {
      const res = await fetch(`/api/inventory/monthly-close?month=${encodeURIComponent(m)}&basis=${basis}`);
      const body = (await res.json()) as MonthlyCloseResponse & ApiErrorBody;
      if (token !== requestSeqRef.current) return;
      if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
      setMonthlyClose(body);
      setError(null);
    } catch (e) {
      if (token !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load monthly close');
    }
  }, []);

  useEffect(() => {
    if (!selectedMonth) return;
    setDryRunPayloads({});
    void loadClose(selectedMonth, closeBasis);
  }, [selectedMonth, closeBasis, loadClose]);

  const handleGenerate = useCallback(async () => {
    if (!selectedMonth) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory/monthly-close/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: selectedMonth, basis: closeBasis }),
      });
      const body = (await res.json()) as GenerateResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setWarnings(body.warnings ?? []);
      await loadClose(selectedMonth, closeBasis);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate drafts');
    } finally {
      setGenerating(false);
    }
  }, [selectedMonth, closeBasis, loadClose]);

  const handleApprove = useCallback(
    async (headerId: number) => {
      if (!selectedMonth) return;
      setBusyHeaderId(headerId);
      setError(null);
      try {
        const res = await fetch('/api/payroll/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headerId }),
        });
        const body = (await res.json()) as ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        await loadClose(selectedMonth, closeBasis);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to approve draft');
      } finally {
        setBusyHeaderId(null);
      }
    },
    [selectedMonth, closeBasis, loadClose],
  );

  const handleDryRun = useCallback(async (headerId: number) => {
    setBusyHeaderId(headerId);
    setError(null);
    try {
      const res = await fetch('/api/inventory/monthly-close/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId, mode: 'dry_run' }),
      });
      const body = (await res.json()) as PostResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setDryRunPayloads((prev) => ({ ...prev, [headerId]: body.payload }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build dry-run preview');
    } finally {
      setBusyHeaderId(null);
    }
  }, []);

  const handlePostLive = useCallback(
    async (headerId: number, entityLabel: string) => {
      if (!selectedMonth) return;
      const confirmed = window.confirm(
        `This will POST a LIVE journal entry to QuickBooks for ${entityLabel}. This writes to the real general ledger and cannot be undone from here. Continue?`,
      );
      if (!confirmed) return;
      setBusyHeaderId(headerId);
      setError(null);
      try {
        const res = await fetch('/api/inventory/monthly-close/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headerId, mode: 'live' }),
        });
        const body = (await res.json()) as PostResponse & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        await loadClose(selectedMonth, closeBasis);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to post journal entry');
      } finally {
        setBusyHeaderId(null);
      }
    },
    [selectedMonth, closeBasis, loadClose],
  );

  const closeReady =
    monthlyClose && monthlyClose.month === selectedMonth && monthlyClose.basis === closeBasis;
  const dates = selectedMonth ? monthDates(selectedMonth) : null;
  const headers = closeReady && monthlyClose ? monthlyClose.headers : [];
  const anyPosted = headers.some((h) => h.status === 'posted');
  const generateLabel = generating ? 'Generating…' : headers.length > 0 ? 'Regenerate drafts' : 'Generate drafts';

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode
    ? 'bg-slate-700 border-slate-600 text-slate-100'
    : 'bg-white border-slate-300 text-slate-900';

  if (loaded && months.length === 0) {
    return (
      <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
        No reconstructed month-end valuations yet — the close appears once the Data Loader ships
        rollback rows.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Explainer id="inventory-close-je" title="What am I looking at?">
        <p>
          The inventory month-end close: what FIFO inventory was worth at the end of the chosen month,
          rolled forward as Beginning + Purchases − Ending = cost of goods consumed, and the adjusting
          entry that brings the QuickBooks inventory-asset balance to the FIFO figure.
        </p>
        <p>
          <strong>Floor vs. full-coverage:</strong> the receipt-priced floor counts only stock traceable
          to a priced purchase receipt (conservative); the full-coverage estimate counts everything on
          LifeFile&rsquo;s lot report, with estimated prices where a receipt is missing. Accounting picks
          which basis becomes official; the point-in-time values behind both live on the{' '}
          <a href="/inventory/as-of" className="underline">
            As-of Value
          </a>{' '}
          page.
        </p>
        <p>
          <strong>Generate drafts</strong> freezes the current numbers into reviewable drafts — the same
          Approve → Dry run → Post workflow as the other journal entries here. Nothing reaches
          QuickBooks without an explicit approve and post, and a posted month locks regeneration.
        </p>
      </Explainer>

      {/* Controls — mirrors the End of Month tab's month/action row. */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className={subText}>Month</span>
          <select
            value={selectedMonth ?? ''}
            onChange={(e) => setMonth(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm ${inputBg}`}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {m} (close {monthDates(m).asOf})
              </option>
            ))}
          </select>
        </label>
        <HelpTip
          label="Floor vs. full-coverage"
          text="Which ending value the roll-forward and journal entry are built from: the conservative receipt-priced floor, or the full-coverage estimate that includes estimated prices for stock without a matching receipt."
        />
        <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
          <button
            onClick={() => setCloseBasis('floor')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              closeBasis === 'floor'
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'text-slate-300 hover:bg-slate-700'
                  : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Receipt-priced floor
          </button>
          <button
            onClick={() => setCloseBasis('full')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              closeBasis === 'full'
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'text-slate-300 hover:bg-slate-700'
                  : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Full-coverage estimate
          </button>
        </div>
        {selectedMonth && (
          <a
            href={`/api/inventory/monthly-close?month=${encodeURIComponent(selectedMonth)}&basis=${closeBasis}&format=xlsx`}
            className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg border ${
              darkMode
                ? 'border-slate-600 text-slate-100 hover:bg-slate-700'
                : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            Excel (close package)
          </a>
        )}
        <button
          onClick={() => void handleGenerate()}
          disabled={generating || anyPosted || !closeReady}
          title={anyPosted ? 'A draft for this month has already posted — regeneration is locked' : undefined}
          className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
          {generateLabel}
        </button>
      </div>

      {warnings.length > 0 && (
        <div
          className={`rounded-xl border p-3 space-y-1 text-sm ${
            darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
          }`}
        >
          {warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      {error && (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-red-950/40 border-red-800 text-red-200' : 'bg-red-50 border-red-300 text-red-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      {dates && (
        <p className={`text-sm ${subText}`}>
          Roll-forward and FIFO target vs. the QuickBooks book balance as of <strong>{dates.asOf}</strong>.
        </p>
      )}

      {closeReady && monthlyClose && selectedMonth ? (
        <>
          <RollForward
            rows={monthlyClose.rollForward}
            purchasesAvailable={monthlyClose.purchasesAvailable}
            darkMode={darkMode}
          />
          {monthlyClose.categoryJournalEntries.length > 0 && (
            <p className={`text-sm ${subText}`}>
              Drafts generate from the <strong>category detail below</strong> (summed from the lot
              ledger, so every line traces to its lots). The roll-forward above is the backward-rollback
              reconstruction — a different method, shown for reference; the two differ for months that
              are not yet LifeFile-anchored.
            </p>
          )}
          <JournalEntryPanel
            journalEntries={monthlyClose.journalEntries}
            categoryJournalEntries={monthlyClose.categoryJournalEntries}
            basis={monthlyClose.basis}
            monthEnd={monthlyClose.monthEnd}
            month={selectedMonth}
            darkMode={darkMode}
            headers={monthlyClose.headers}
            linesById={monthlyClose.linesById}
            busyHeaderId={busyHeaderId}
            dryRunPayloads={dryRunPayloads}
            onApprove={(id) => void handleApprove(id)}
            onDryRun={(id) => void handleDryRun(id)}
            onPostLive={(id, entityLabel) => void handlePostLive(id, entityLabel)}
          />
        </>
      ) : (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          Loading monthly close…
        </div>
      )}
    </div>
  );
}
