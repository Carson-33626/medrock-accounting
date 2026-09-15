'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import Explainer from '@/components/Explainer';
import HelpTip from '@/components/HelpTip';
import RollForward from '@/components/RollForward';
import JournalEntryPanel, { DryRunPreview, type QbJournalEntryPayload } from '@/components/JournalEntryPanel';
import JeSourceWorkbookLink from '@/components/JeSourceWorkbookLink';
import { DismissibleBanner } from '@/components/DismissibleBanner';
import { monthDates } from '@/lib/inventory/month-dates';
import { formatAccount } from '@/lib/inventory/account-label';
import {
  findCloseHeader,
  CLOSE_STATUS_LABEL,
  CORRECTION_MONTH,
  monthlyCloseLock,
  rollForwardFromCategories,
} from '@/lib/inventory/monthly-close';
import { InventoryMethodology } from './InventoryMethodology';
import { InventoryDecisions } from './InventoryDecisions';
import type {
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  MonthlyCloseResponse,
  OpeningCorrection,
  RollbackResponse,
  RollbackValuationRow,
} from '@/types/inventory';

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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
export function InventoryCloseTab({ initialMonth }: { initialMonth?: string }) {
  const { darkMode } = useDarkMode();
  const [rollbackRows, setRollbackRows] = useState<RollbackValuationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // `initialMonth` is the return trip from the Point-in-Time page, so a reviewer
  // who drilled into March's category detail lands back on March's close rather
  // than on the newest month.
  const [month, setMonth] = useState<string | null>(initialMonth ?? null);
  // Receipt-priced floor is THE methodology (Carson, 2026-08-26) — not user
  // selectable. The API still accepts a basis param for compatibility.
  const closeBasis: CloseBasis = 'floor';
  const [monthlyClose, setMonthlyClose] = useState<MonthlyCloseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [busyHeaderId, setBusyHeaderId] = useState<number | null>(null);
  /** Bumped after any approve/post so the lab-accrual card re-reads its own drafts —
   *  it owns its data (it reads QuickBooks live) rather than riding the close payload. */
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
  // The list starts at the year-end correction month: nothing before 2025-12 is
  // closable (Carson, 2026-09-15: "the dropdown firmly starts 12-2025 to show the
  // adjustment piece, then going forwards it is normal").
  const months = useMemo(() => {
    const set = new Set(rollbackRows.map((r) => r.as_of_month).filter((m) => m >= CORRECTION_MONTH));
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rollbackRows]);

  const selectedMonth = month ?? months[0] ?? null;
  /** Non-null on the correction month (and anything earlier): the regular monthly
   *  close is hard-locked there — only the correction card renders. */
  const closeLock = selectedMonth ? monthlyCloseLock(selectedMonth) : null;

  const loadClose = useCallback(async (m: string, basis: CloseBasis) => {
    const token = ++requestSeqRef.current;
    try {
      const res = await fetch(`/api/inventory/monthly-close?month=${encodeURIComponent(m)}&basis=${basis}`);
      // Vercel answers a crashed or timed-out function with a plain-text page
      // ("An error occurred with your deployment…"), not JSON. Parsing that blindly
      // surfaced as `Unexpected token 'A'… is not valid JSON` (Carson, 2026-09-15,
      // February after the TX post errored). Read the text first and say what
      // actually came back.
      const raw = await res.text();
      let body: MonthlyCloseResponse & ApiErrorBody;
      try {
        body = JSON.parse(raw) as MonthlyCloseResponse & ApiErrorBody;
      } catch {
        if (token !== requestSeqRef.current) return;
        throw new Error(
          `The server did not return data for ${m} (HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}). ` +
            'Usually a timed-out or restarted function — pick the month again to retry.' +
            (raw.trim() ? ` Server said: ${raw.trim().slice(0, 160)}` : ''),
        );
      }
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

  const [generatingCorrection, setGeneratingCorrection] = useState(false);
  // Sub-tabs: the JE workflow, the shareable methodology/evidence breakdown,
  // and the decision record for ownership review.
  const [subTab, setSubTab] = useState<'close' | 'method' | 'decisions'>('close');

  const handleGenerateCorrection = useCallback(async () => {
    if (!selectedMonth) return;
    setGeneratingCorrection(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory/monthly-close/correction', { method: 'POST' });
      const body = (await res.json()) as (OpeningCorrection & { warnings: string[] }) & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setWarnings(body.warnings ?? []);
      await loadClose(selectedMonth, closeBasis);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate the opening correction');
    } finally {
      setGeneratingCorrection(false);
    }
  }, [selectedMonth, closeBasis, loadClose]);

  // A CORRECTION to a posted month for one company (ds-correction-entry-2026-09-15):
  // the month recomputed against the book that now holds the posted entry, drafted
  // as `<parent>-2`. Barbara, via Carson 2026-09-15.
  const [generatingCloseCorrection, setGeneratingCloseCorrection] = useState<string | null>(null);
  const handleGenerateCloseCorrection = useCallback(
    async (location: string) => {
      if (!selectedMonth) return;
      const entity = location.replace(/^MedRock (Florida|Tennessee|Texas)$/, (_m, s: string) =>
        s === 'Florida' ? 'MedRock FL' : s === 'Tennessee' ? 'MedRock TN' : 'MedRock TX',
      );
      setGeneratingCloseCorrection(location);
      setError(null);
      try {
        const res = await fetch('/api/inventory/monthly-close/generate-correction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ month: selectedMonth, basis: closeBasis, entity }),
        });
        const body = (await res.json()) as { nothingToCorrect?: boolean; docNumber?: string; warnings?: string[] } & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        const notes = body.warnings ?? [];
        if (body.nothingToCorrect) {
          notes.push(`${location}: nothing to correct — FIFO ties to the book as posted and the lab accrual stands.`);
        }
        setWarnings(notes);
        await loadClose(selectedMonth, closeBasis);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to generate the correction');
      } finally {
        setGeneratingCloseCorrection(null);
      }
    },
    [selectedMonth, closeBasis, loadClose],
  );

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
        `This will POST a LIVE journal entry to QuickBooks for ${entityLabel}. It writes to the real general ledger. ` +
          'If it needs to change, the posted receipt has a "Pull back from QuickBooks" button that deletes the entry and returns it to a draft. Continue?',
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

  // Pull a posted entry back out of QuickBooks so it can be regenerated and reposted.
  // Carson, 2026-09-14: "an undo / pull down button to delete the posted journal so
  // we can regenerate and repost it." Two confirmations: it deletes from the live
  // general ledger, and the second asks for the reason that lands in the audit row.
  const handleUnpost = useCallback(
    async (headerId: number, entityLabel: string, docNumber: string) => {
      if (!selectedMonth) return;
      const confirmed = window.confirm(
        `This will DELETE ${docNumber} from QuickBooks for ${entityLabel} and return it to a draft so it can be regenerated and reposted. ` +
          'The workbook attached to it is removed too. Continue?',
      );
      if (!confirmed) return;
      const reason = window.prompt('Why is this entry being pulled back? (recorded in the audit log)', '') ?? '';
      setBusyHeaderId(headerId);
      setError(null);
      try {
        const res = await fetch('/api/inventory/monthly-close/unpost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headerId, reason }),
        });
        const body = (await res.json()) as ApiErrorBody & { detachFailed?: string[] };
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (body.detachFailed && body.detachFailed.length > 0) {
          setError(`Entry deleted, but ${body.detachFailed.length} attachment(s) could not be removed from QuickBooks — see the audit log.`);
        }
        await loadClose(selectedMonth, closeBasis);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to pull the entry back from QuickBooks');
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
  // When this month's drafts were last built — the newest `generated` audit stamp
  // across its headers. Comes from the server, so it survives reloads and only
  // moves when a Generate actually succeeded.
  const lastGenerated = headers.reduce<string | null>(
    (latest, h) => (h.generated_at && (!latest || h.generated_at > latest) ? h.generated_at : latest),
    null,
  );
  const lastGeneratedLabel =
    headers.length === 0
      ? 'Not generated yet'
      : lastGenerated
        ? `Last generated ${new Date(lastGenerated).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}`
        : 'Last generated before 2026-09-15 (not stamped)';

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
          <strong>Basis:</strong> stock is valued at the actual purchase price of the lots it sits in —
          only stock traceable to a priced purchase receipt is counted (over 99.4% of on-hand value).
          The point-in-time values behind these figures live on the{' '}
          <a href="/inventory" className="underline">
            Inventory Valuation
          </a>{' '}
          page.
        </p>
        <p>
          <strong>Generate drafts</strong> freezes the current numbers into reviewable drafts — the same
          Approve → Dry run → Post workflow as the other journal entries here. Nothing reaches
          QuickBooks without an explicit approve and post, and a posted month locks regeneration.
        </p>
      </Explainer>

      {/* Sub-tabs: the working JE surface vs. the shareable methodology breakdown. */}
      <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
        <button
          onClick={() => setSubTab('close')}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
            subTab === 'close'
              ? 'bg-indigo-600 text-white'
              : darkMode
                ? 'text-slate-300 hover:bg-slate-700'
                : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Close JEs
        </button>
        <button
          onClick={() => setSubTab('method')}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
            subTab === 'method'
              ? 'bg-indigo-600 text-white'
              : darkMode
                ? 'text-slate-300 hover:bg-slate-700'
                : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Methodology &amp; evidence
        </button>
        <button
          onClick={() => setSubTab('decisions')}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
            subTab === 'decisions'
              ? 'bg-indigo-600 text-white'
              : darkMode
                ? 'text-slate-300 hover:bg-slate-700'
                : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Decisions
        </button>
      </div>

      {subTab === 'method' ? (
        <InventoryMethodology darkMode={darkMode} />
      ) : subTab === 'decisions' ? (
        <InventoryDecisions darkMode={darkMode} />
      ) : (
        <>
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
          label="Basis: receipt-priced"
          text="All figures value stock at the actual purchase price of the lots it sits in; only stock traceable to a priced purchase receipt is counted — over 99.4% of on-hand value. The generated entry sums from the lot-depletion ledger on the same basis."
        />
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
        {closeReady && closeLock === null && (
          <span className={`ml-auto text-xs ${subText}`} title="From the audit trail — set only by a successful Generate">
            {lastGeneratedLabel}
          </span>
        )}
        <button
          onClick={() => void handleGenerate()}
          disabled={generating || anyPosted || !closeReady || closeLock !== null}
          title={
            closeLock ?? (anyPosted ? 'A draft for this month has already posted — regeneration is locked' : undefined)
          }
          className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
          {generateLabel}
        </button>
      </div>

      {/* A FAILED category read (as opposed to a month with genuinely no
          categories) must be visible here, not only in the server log: it is the
          state in which Generate refuses to run and nothing on the page would
          otherwise explain the empty category table. */}
      {closeReady && monthlyClose?.categoryUnavailable && (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            <strong>Category detail unavailable</strong> — {monthlyClose.categoryUnavailable}. The
            roll-forward and rollback reference figures below are still valid, but drafts cannot be
            generated and existing drafts will not be touched until this clears.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <DismissibleBanner tone="warning" darkMode={darkMode} onDismiss={() => setWarnings([])}>
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </DismissibleBanner>
      )}

      {error && (
        <DismissibleBanner tone="error" darkMode={darkMode} onDismiss={() => setError(null)}>
          <p>{error}</p>
        </DismissibleBanner>
      )}

      {closeReady && monthlyClose?.openingCorrection && (
        <OpeningCorrectionCard
          correction={monthlyClose.openingCorrection}
          darkMode={darkMode}
          generating={generatingCorrection}
          busyHeaderId={busyHeaderId}
          onGenerate={() => void handleGenerateCorrection()}
          onApprove={(id) => void handleApprove(id)}
          onDryRun={(id) => void handleDryRun(id)}
          onPostLive={(id, label) => void handlePostLive(id, label)}
          onUnpost={(id, label, doc) => void handleUnpost(id, label, doc)}
          dryRunPayloads={dryRunPayloads}
        />
      )}

      {/* Lab supplies no longer has its own card: since 2026-09-14 the accrual is a
          contributor INSIDE each month's close entry (lab-supplies-contribution.ts),
          so it generates, approves and posts with the entry. */}

      {closeLock !== null && (
        <div
          className={`rounded-xl border-2 p-4 text-sm ${
            darkMode ? 'bg-slate-800 border-slate-600 text-slate-200' : 'bg-slate-50 border-slate-300 text-slate-800'
          }`}
        >
          <p className="font-semibold">Monthly close locked for {selectedMonth}.</p>
          <p className={`mt-1 ${subText}`}>
            December 2025 carries the one-time year-end correction above and nothing else: it trues each
            inventory sub-account to the counted FIFO value as of 12/31/2025 and is the opening balance
            for 2026. There is no regular &ldquo;Inv Adj&rdquo; entry for December or any earlier month,
            and one cannot be generated here. The monthly close runs from January 2026 forward.
          </p>
        </div>
      )}

      {closeLock === null && dates && (
        <p className={`text-sm ${subText}`}>
          Roll-forward and FIFO target vs. the QuickBooks book balance as of <strong>{dates.asOf}</strong>.
        </p>
      )}

      {closeLock !== null ? null : closeReady && monthlyClose && selectedMonth ? (
        <>
          {/* On a count-anchored month the category ledger is what posts, so the
              roll-forward reads from it and agrees with the entry table below.
              Unanchored months keep the backward-rollback reference. */}
          {(() => {
            const anchored =
              monthlyClose.firstAnchoredMonth !== null && selectedMonth >= monthlyClose.firstAnchoredMonth;
            const rows = anchored ? rollForwardFromCategories(monthlyClose.categoryRollForward) : monthlyClose.rollForward;
            return (
              <>
                <RollForward
                  rows={rows}
                  purchasesAvailable={anchored ? true : monthlyClose.purchasesAvailable}
                  darkMode={darkMode}
                />
                {monthlyClose.categoryJournalEntries.length > 0 && (
                  <p className={`text-sm ${subText}`}>
                    {anchored ? (
                      <>
                        Drafts generate from the <strong>category detail below</strong> (summed from the lot
                        ledger, so every line traces to its lots). The roll-forward above is the same ledger
                        summed by location, so the two agree.
                      </>
                    ) : (
                      <>
                        Drafts generate from the <strong>category detail below</strong> (summed from the lot
                        ledger, so every line traces to its lots). The roll-forward above is the backward-rollback
                        reconstruction — a different method, shown for reference; the two differ for months that
                        are not yet LifeFile-anchored.
                      </>
                    )}
                  </p>
                )}
              </>
            );
          })()}
          <JournalEntryPanel
            journalEntries={monthlyClose.journalEntries}
            categoryJournalEntries={monthlyClose.categoryJournalEntries}
            categoryRollForward={monthlyClose.categoryRollForward}
            categoryCogsSeries={monthlyClose.categoryCogsSeries}
            firstAnchoredMonth={monthlyClose.firstAnchoredMonth}
            basis={monthlyClose.basis}
            monthEnd={monthlyClose.monthEnd}
            month={selectedMonth}
            darkMode={darkMode}
            headers={monthlyClose.headers}
            linesById={monthlyClose.linesById}
            busyHeaderId={busyHeaderId}
            dryRunPayloads={dryRunPayloads}
            accountNumbers={monthlyClose.accountNumbers}
            onApprove={(id) => void handleApprove(id)}
            onDryRun={(id) => void handleDryRun(id)}
            onPostLive={(id, entityLabel) => void handlePostLive(id, entityLabel)}
            onUnpost={(id, entityLabel, doc) => void handleUnpost(id, entityLabel, doc)}
            onGenerateCorrection={(location) => void handleGenerateCloseCorrection(location)}
            generatingCorrection={generatingCloseCorrection}
          />
        </>
      ) : (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          Loading monthly close…
        </div>
      )}
        </>
      )}
    </div>
  );
}

/**
 * The one-time year-end correction (dated 2025-12-31): trues each QB inventory
 * sub-account to the FIFO 12/31 value, offset to the dedicated correction account.
 * Rendered only when December 2025 is selected. Same Approve → Dry run →
 * Post workflow as the monthly drafts — the handlers are header-generic.
 */
function OpeningCorrectionCard({
  correction,
  darkMode,
  generating,
  busyHeaderId,
  onGenerate,
  onApprove,
  onDryRun,
  onPostLive,
  onUnpost,
  dryRunPayloads,
}: {
  correction: OpeningCorrection;
  darkMode: boolean;
  generating: boolean;
  busyHeaderId: number | null;
  /** Dry-run results keyed by header id — rendered under the entry they belong to. */
  dryRunPayloads: Record<number, QbJournalEntryPayload>;
  onGenerate: () => void;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
  /** Delete the posted entry from QuickBooks and return it to a draft. */
  onUnpost: (headerId: number, entityLabel: string, docNumber: string) => void;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const thCls = `text-left font-medium py-1 pr-4 ${subText}`;
  const numCls = 'py-1 pr-4 text-right tabular-nums';

  const anyPosted = correction.headers.some((h) => h.status === 'posted');
  const missingOffset = correction.locations.filter((l) => l.bookAvailable && !l.offsetFound);
  const netTotal = correction.locations.reduce((s, l) => s + l.netAdjustment, 0);

  const statusChip = (h: InvCloseHeader) => {
    const palette: Record<InvCloseHeader['status'], string> = {
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

  // Once every correction draft has posted, the card collapses to a receipt: doc
  // number, QuickBooks date and amount per entity, with the detail one click away.
  // Carson, 2026-09-14: "will the system recognize that it has been posted and
  // collapse and notate this section?" Regeneration is locked server-side at the
  // first posted header, so a collapsed card can never be re-drafted by accident.
  const allPosted = correction.headers.length > 0 && correction.headers.every((h) => h.status === 'posted');
  const [expanded, setExpanded] = useState(false);

  if (allPosted && !expanded) {
    return (
      <div
        className={`rounded-xl shadow-sm border-2 ${darkMode ? 'border-emerald-800' : 'border-emerald-300'} ${cardBg} p-4 space-y-2`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Year-end correction — posted to QuickBooks
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  darkMode ? 'bg-emerald-900/60 text-emerald-200' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                Posted
              </span>
            </h3>
            <p className={`text-sm ${subText}`}>
              The one-time true-up dated {correction.openingDate} is on the books. Net company-wide:{' '}
              <span className="font-semibold">{usd(netTotal)}</span>. Regeneration is locked.
            </p>
          </div>
          <button
            onClick={() => setExpanded(true)}
            className={`ml-auto px-3 py-1.5 text-xs font-medium rounded-lg border ${
              darkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100'
            }`}
          >
            Show detail
          </button>
        </div>
        <ul className="text-sm space-y-1">
          {correction.headers.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3">
              <span className="font-medium w-8">{h.entity.replace('MedRock ', '')}</span>
              <span className="font-mono text-xs">{h.qb_doc_number ?? `#${h.id}`}</span>
              <span className={subText}>{h.txn_date ?? correction.openingDate}</span>
              <span className="tabular-nums">{usd(h.total_debits)}</span>
              <JeSourceWorkbookLink
                headerId={h.id}
                docNumber={h.qb_doc_number ?? h.entity}
                darkMode={darkMode}
                compact
              />
              <button
                onClick={() => onUnpost(h.id, h.entity, h.qb_doc_number ?? `#${h.id}`)}
                disabled={busyHeaderId === h.id}
                title="Delete this entry from QuickBooks and return it to a draft, so it can be regenerated and reposted"
                className={`ml-auto px-2 py-0.5 text-xs font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-red-800 text-red-300 hover:bg-red-950/40' : 'border-red-300 text-red-700 hover:bg-red-50'
                }`}
              >
                Pull back from QuickBooks
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl shadow-sm border-2 ${darkMode ? 'border-indigo-700' : 'border-indigo-300'} ${cardBg} p-4 space-y-4`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            Year-end correction — one-time true-up to FIFO ({correction.openingDate})
            {allPosted && (
              <button
                onClick={() => setExpanded(false)}
                className={`px-2 py-0.5 text-xs font-medium rounded-lg border ${
                  darkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100'
                }`}
              >
                Collapse
              </button>
            )}
          </h3>
          <p className={`text-sm ${subText}`}>
            Trues each inventory sub-account from its QuickBooks balance (as of {correction.bookAsOf}) to the
            FIFO year-end value, each offset to <span className="font-medium">{correction.offsetAccount}</span>.
            Posts once as a 13th-month entry, so every 2026 month carries only its own movement. Net
            company-wide: <span className="font-semibold">{usd(netTotal)}</span>.
          </p>
        </div>
        <button
          onClick={onGenerate}
          disabled={generating || anyPosted}
          title={anyPosted ? 'The opening correction has posted — regeneration is locked' : undefined}
          className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="w-4 h-4" aria-hidden />
          )}
          {correction.headers.length > 0 ? 'Regenerate correction drafts' : 'Generate correction drafts'}
        </button>
      </div>

      {missingOffset.length > 0 && (
        <div
          className={`rounded-lg border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            <strong>COGS account missing</strong> in {missingOffset.map((l) => l.location).join(', ')}:
            one of the paired Cost of Goods Sold sub-accounts is not in that company&apos;s chart —
            drafts are refused for those companies until it resolves.
          </p>
        </div>
      )}

      {correction.locations.map((loc) => {
        const header = findCloseHeader(loc.location, correction.headers);
        const lines: InvCloseLine[] = header ? (correction.linesById[String(header.id)] ?? []) : [];
        return (
          <div key={loc.location} className={`rounded-lg border ${border} p-3 space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{loc.location}</span>
              <span className={`text-sm ${subText}`}>net {usd(loc.netAdjustment)}</span>
              {header && statusChip(header)}
              {header && (
                <span className={`flex items-center gap-2${header.status === 'posted' ? ' ml-auto' : ''}`}>
                  {/* The correction plus its source detail, posted or not — an audit asks for
                      the evidence after the entry is live, not only while it is a draft. */}
                  <JeSourceWorkbookLink
                    headerId={header.id}
                    docNumber={header.qb_doc_number ?? loc.location}
                    darkMode={darkMode}
                    compact
                  />
                  {/* A posted row in the expanded card (one company posted, another not
                      yet) still needs its pull-back — Carson, 2026-09-14, after FL posted
                      and TN was refused: "there is no delete button on the FL piece." */}
                  {header.status === 'posted' && (
                    <button
                      onClick={() => onUnpost(header.id, loc.location, header.qb_doc_number ?? `#${header.id}`)}
                      disabled={busyHeaderId === header.id}
                      title="Delete this entry from QuickBooks and return it to a draft, so it can be regenerated and reposted"
                      className={`px-2.5 py-1 text-xs font-medium rounded-lg border disabled:opacity-50 ${
                        darkMode ? 'border-red-800 text-red-300 hover:bg-red-950/40' : 'border-red-300 text-red-700 hover:bg-red-50'
                      }`}
                    >
                      Pull back from QuickBooks
                    </button>
                  )}
                </span>
              )}
              {header && header.status !== 'posted' && (
                <span className="ml-auto flex items-center gap-2">
                  {(header.status === 'draft' || header.status === 'needs_review') && (
                    <button
                      onClick={() => onApprove(header.id)}
                      disabled={busyHeaderId === header.id}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                  <button
                    onClick={() => onDryRun(header.id)}
                    disabled={busyHeaderId === header.id}
                    className={`px-2.5 py-1 text-xs font-medium rounded-lg border ${
                      darkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    Dry run
                  </button>
                  {header.status === 'approved' && (
                    <button
                      onClick={() => onPostLive(header.id, loc.location)}
                      disabled={busyHeaderId === header.id}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Post live
                    </button>
                  )}
                </span>
              )}
            </div>

            {!loc.bookAvailable ? (
              <p className={`text-sm ${subText}`}>QuickBooks book balance unavailable — reconnect the realm.</p>
            ) : (
              <table className="text-sm w-full">
                <thead>
                  <tr>
                    <th className={thCls}>Inventory account</th>
                    <th className={`${thCls} text-right`}>QuickBooks 12/31</th>
                    <th className={`${thCls} text-right`}>FIFO 12/31</th>
                    <th className={`${thCls} text-right`}>Correction</th>
                    <th className={thCls}>Offset to</th>
                  </tr>
                </thead>
                <tbody>
                  {loc.rows.map((r) => (
                    <tr key={r.account + (r.qbCategory ?? '')}>
                      <td className="py-1 pr-4">
                        {formatAccount(r.account, loc.accountNumbers)}
                        {!r.mapped && <span className={`ml-1 text-xs ${subText}`}>(residual: {r.qbCategory})</span>}
                      </td>
                      <td className={numCls}>{usd(r.book)}</td>
                      <td className={numCls}>{usd(r.fifo)}</td>
                      <td className={`${numCls} font-medium`}>{usd(r.adjustment)}</td>
                      <td className={`py-1 pr-4 text-xs ${subText}`}>{formatAccount(r.offsetAccount, loc.accountNumbers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {header && lines.length > 0 && (
              <details className="text-sm">
                <summary className={`cursor-pointer ${subText}`}>
                  Draft lines ({lines.length}) — frozen at generation; this is what posts
                </summary>
                <table className="mt-1 w-full">
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td className="py-0.5 pr-4">{formatAccount(l.accountName, loc.accountNumbers)}</td>
                        <td className={numCls}>{l.postingType === 'Debit' ? usd(l.amount) : ''}</td>
                        <td className={numCls}>{l.postingType === 'Credit' ? usd(l.amount) : ''}</td>
                        <td className={`py-0.5 ${subText}`}>{l.memo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {header && dryRunPayloads[header.id] && (
              <DryRunPreview darkMode={darkMode} payload={dryRunPayloads[header.id]} />
            )}
          </div>
        );
      })}
    </div>
  );
}
