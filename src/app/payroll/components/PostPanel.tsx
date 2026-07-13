'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { AlertTriangle, Ban, CheckCircle2, Eye, Loader2, RefreshCw, ShieldCheck, XCircle, Zap } from 'lucide-react';

/**
 * Local mirrors of the payroll API response shapes (web/src/lib/payroll/store.ts
 * PayrollHeader, web/src/lib/payroll/types.ts ReconcileResult, web/src/lib/payroll/
 * qb-journal.ts QbJournalEntryPayload/PostResult). Not imported directly — those
 * modules pull in the RDS pool (`pg`) / QuickBooks client, which must never land in a
 * client bundle.
 */
type HeaderStatus = 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';

interface PayrollHeader {
  id: number;
  entity: string;
  pay_date: string;
  pay_group: string;
  period_start: string | null;
  period_end: string | null;
  status: HeaderStatus;
  total_debits: number;
  total_credits: number;
  variance: number;
  row_count: number;
  qb_entry_id: string | null;
  qb_doc_number: string | null;
}

interface DraftResponse {
  header: PayrollHeader;
}

interface ReconcileResult {
  balanced: boolean;
  variance: number;
  grossOk: boolean;
  netOk: boolean;
  taxesEeOk: boolean;
  taxesErOk: boolean;
  unmappedColumns: string[];
  unmappedPositions: string[];
  errors: string[];
  postable: boolean;
}

interface QbJournalEntryLineDetail {
  PostingType: 'Debit' | 'Credit';
  AccountRef: { value: string };
  DepartmentRef?: { value: string };
  ClassRef?: { value: string };
}

interface QbJournalEntryLine {
  Amount: number;
  DetailType: 'JournalEntryLineDetail';
  Description?: string;
  JournalEntryLineDetail: QbJournalEntryLineDetail;
}

interface QbJournalEntryPayload {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  Line: QbJournalEntryLine[];
}

interface PostResult {
  mode: 'dry_run' | 'live';
  payload: QbJournalEntryPayload;
  qbEntryId?: string;
  qbDocNumber?: string;
}

interface ApiErrorBody {
  error?: string;
  reconcile?: ReconcileResult;
}

/**
 * Post panel: two-step, safety-critical posting flow for one draft header —
 *   1. Reconcile → shows postable + blockers.
 *   2. Preview (dry-run) → renders the exact QuickBooks JournalEntry payload, read-only.
 *   3. Approve → flips header status to 'approved'.
 *   4. Post to QuickBooks (LIVE, writes the real ledger) — disabled unless
 *      reconcile.postable === true AND status === 'approved'. Requires an explicit
 *      confirm() before it fires.
 *
 * Payloads/responses are rendered in the UI but never written to console.log.
 */
interface PostPanelProps {
  /** The draft selected on the Payrolls landing — auto-loaded; hides the manual id input. */
  headerId?: number | null;
}

export function PostPanel({ headerId: selectedHeaderId }: PostPanelProps = {}) {
  const { darkMode } = useDarkMode();

  const [headerIdInput, setHeaderIdInput] = useState<string>('');
  const [headerId, setHeaderId] = useState<number | null>(null);
  const [header, setHeader] = useState<PayrollHeader | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<QbJournalEntryPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postErrorReconcile, setPostErrorReconcile] = useState<ReconcileResult | null>(null);
  const [liveResult, setLiveResult] = useState<{ qbEntryId?: string; qbDocNumber?: string } | null>(null);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const resetDownstream = useCallback(() => {
    setReconcileResult(null);
    setPreviewPayload(null);
    setPreviewError(null);
    setApproveError(null);
    setPostError(null);
    setPostErrorReconcile(null);
    setLiveResult(null);
  }, []);

  const loadHeader = useCallback(
    async (id: number) => {
      setLoading(true);
      setError(null);
      resetDownstream();
      try {
        const res = await fetch(`/api/payroll/run/${id}`);
        const body = (await res.json()) as DraftResponse & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setHeader(body.header);
        setHeaderId(id);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load draft';
        setError(message);
        setHeader(null);
        setHeaderId(null);
      } finally {
        setLoading(false);
      }
    },
    [resetDownstream],
  );

  const handleLoadClick = useCallback(() => {
    const id = Number(headerIdInput);
    if (!Number.isFinite(id) || id <= 0) {
      setError('Enter a valid numeric draft id');
      return;
    }
    void loadHeader(id);
  }, [headerIdInput, loadHeader]);

  // Driven by the selected payroll card: auto-load and keep in sync with the Review view above.
  useEffect(() => {
    if (selectedHeaderId != null) void loadHeader(selectedHeaderId);
  }, [selectedHeaderId, loadHeader]);

  const handleReconcile = useCallback(async () => {
    if (headerId === null) return;
    setReconciling(true);
    setError(null);
    try {
      const res = await fetch('/api/payroll/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId }),
      });
      const body = (await res.json()) as ReconcileResult & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReconcileResult(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to reconcile draft';
      setError(message);
      setReconcileResult(null);
    } finally {
      setReconciling(false);
    }
  }, [headerId]);

  const handlePreview = useCallback(async () => {
    if (headerId === null) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreviewPayload(null);
    try {
      const res = await fetch('/api/payroll/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId, mode: 'dry_run' }),
      });
      const body = (await res.json()) as PostResult & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      // Do NOT console.log `body` — it is the exact QB payload, rendered read-only below instead.
      setPreviewPayload(body.payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to build dry-run preview';
      setPreviewError(message);
    } finally {
      setPreviewing(false);
    }
  }, [headerId]);

  const handleApprove = useCallback(async () => {
    if (headerId === null) return;
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch('/api/payroll/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId }),
      });
      const body = (await res.json()) as { ok?: boolean } & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setHeader((prev) => (prev ? { ...prev, status: 'approved' } : prev));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to approve draft';
      setApproveError(message);
    } finally {
      setApproving(false);
    }
  }, [headerId]);

  const canPostLive = headerId !== null && reconcileResult?.postable === true && header?.status === 'approved';

  const handlePostLive = useCallback(async () => {
    if (headerId === null || !canPostLive) return;
    const confirmed = window.confirm(
      `This will POST a LIVE journal entry to QuickBooks for ${header?.entity ?? 'this entity'} (${header?.pay_date ?? ''}). This writes to the real general ledger and cannot be undone from here. Continue?`,
    );
    if (!confirmed) return;

    setPosting(true);
    setPostError(null);
    setPostErrorReconcile(null);
    setLiveResult(null);
    try {
      const res = await fetch('/api/payroll/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId, mode: 'live' }),
      });
      const body = (await res.json()) as PostResult & ApiErrorBody;
      if (!res.ok) {
        // 409 (not postable / already posted) or 503 (decrypt key not configured).
        setPostError(body.error ?? `Request failed (${res.status})`);
        setPostErrorReconcile(body.reconcile ?? null);
        return;
      }
      // Do NOT console.log `body` — never log live QB responses.
      setLiveResult({ qbEntryId: body.qbEntryId, qbDocNumber: body.qbDocNumber });
      setHeader((prev) => (prev ? { ...prev, status: 'posted', qb_entry_id: body.qbEntryId ?? prev.qb_entry_id, qb_doc_number: body.qbDocNumber ?? prev.qb_doc_number } : prev));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to post journal entry';
      setPostError(message);
    } finally {
      setPosting(false);
    }
  }, [headerId, canPostLive, header]);

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-4 border ${border}`}>
      <div className="flex items-center justify-between">
        <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Post</p>
      </div>

      {/* Header selector — hidden when driven by the selected payroll card. */}
      {selectedHeaderId == null ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className={`text-sm ${subText}`}>
            Draft ID
            <input
              type="number"
              min={1}
              value={headerIdInput}
              onChange={(e) => setHeaderIdInput(e.target.value)}
              placeholder="e.g. 12"
              className={`block mt-1 w-32 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}
            />
          </label>
          <button
            onClick={handleLoadClick}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
            {loading ? 'Loading…' : 'Load'}
          </button>

          {header && (
            <div className={`ml-auto text-sm ${subText}`}>
              <span className="font-semibold">{header.entity}</span> · {header.pay_date} · {header.pay_group} ·{' '}
              <StatusBadge darkMode={darkMode} status={header.status} />
            </div>
          )}
        </div>
      ) : (
        header && (
          <div className={`text-sm ${subText} flex items-center gap-2`}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            <span className="font-semibold">{header.entity}</span> · {header.pay_date} · {header.pay_group} ·{' '}
            <StatusBadge darkMode={darkMode} status={header.status} />
          </div>
        )
      )}

      {error && (
        <div
          className={`rounded-lg border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-red-950/40 border-red-800 text-red-200' : 'bg-red-50 border-red-300 text-red-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      {header && (
        <>
          {/* Step 1: Reconcile */}
          <div className={`rounded-lg border p-3 space-y-2 ${border}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold">1. Reconcile</p>
              <button
                onClick={() => void handleReconcile()}
                disabled={reconciling}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {reconciling ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
                {reconciling ? 'Reconciling…' : 'Reconcile'}
              </button>
            </div>

            {reconcileResult && (
              <div className="space-y-2">
                <div
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    reconcileResult.postable
                      ? darkMode
                        ? 'bg-emerald-950/60 text-emerald-200 border-emerald-800'
                        : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : darkMode
                        ? 'bg-red-950/60 text-red-200 border-red-800'
                        : 'bg-red-50 text-red-700 border-red-200'
                  }`}
                >
                  {reconcileResult.postable ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <XCircle className="w-3.5 h-3.5" aria-hidden />}
                  {reconcileResult.postable ? 'Postable' : 'Not postable'}
                </div>

                {!reconcileResult.postable && reconcileResult.errors.length > 0 && (
                  <ul className="space-y-1">
                    {reconcileResult.errors.map((e, i) => (
                      <li key={i} className={`text-xs flex items-start gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                        <span>{e}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {(reconcileResult.unmappedColumns.length > 0 || reconcileResult.unmappedPositions.length > 0) && (
                  <p className={`text-xs ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
                    {reconcileResult.unmappedColumns.length} unmapped column(s), {reconcileResult.unmappedPositions.length} unmapped
                    position(s) blocking posting.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Step 2: Preview (dry-run) */}
          <div className={`rounded-lg border p-3 space-y-2 ${border}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold">2. Preview (dry-run)</p>
              <button
                onClick={() => void handlePreview()}
                disabled={previewing}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                {previewing ? 'Building…' : 'Preview (dry-run)'}
              </button>
            </div>

            {previewError && (
              <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
                {previewError}
              </p>
            )}

            {previewPayload && (
              <div className="space-y-2">
                <p className={`text-xs ${subText}`}>
                  Exact QuickBooks JournalEntry payload — <strong>{previewPayload.DocNumber}</strong> ·{' '}
                  {previewPayload.TxnDate} · {previewPayload.Line.length} line(s). Read-only.
                </p>
                <pre
                  className={`text-[11px] font-mono rounded-lg border p-3 overflow-x-auto max-h-80 overflow-y-auto ${
                    darkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  {JSON.stringify(previewPayload, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Step 3: Approve */}
          <div className={`rounded-lg border p-3 space-y-2 ${border}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold">3. Approve</p>
              <button
                onClick={() => void handleApprove()}
                disabled={approving || header.status === 'approved' || header.status === 'posted'}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {approving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldCheck className="w-4 h-4" aria-hidden />}
                {header.status === 'approved' || header.status === 'posted' ? 'Approved' : approving ? 'Approving…' : 'Approve'}
              </button>
            </div>
            {approveError && (
              <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
                {approveError}
              </p>
            )}
          </div>

          {/* Step 4: Post to QuickBooks (LIVE) */}
          <div
            className={`rounded-lg border-2 p-3 space-y-2 ${
              darkMode ? 'border-orange-800 bg-orange-950/20' : 'border-orange-300 bg-orange-50'
            }`}
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className={`text-sm font-semibold flex items-center gap-1.5 ${darkMode ? 'text-orange-200' : 'text-orange-900'}`}>
                <Zap className="w-4 h-4" aria-hidden />
                4. Post to QuickBooks (live)
              </p>
              <button
                onClick={() => void handlePostLive()}
                disabled={!canPostLive || posting}
                title={canPostLive ? 'Post the live journal entry to QuickBooks' : 'Reconcile as postable and approve the draft first'}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              >
                {posting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Zap className="w-4 h-4" aria-hidden />}
                {posting ? 'Posting…' : 'Post to QuickBooks'}
              </button>
            </div>

            <p className={`text-xs ${darkMode ? 'text-orange-200/80' : 'text-orange-800'}`}>
              Writes a real journal entry to the QuickBooks general ledger for {header.entity}. Enabled only when the
              draft reconciles as postable <em>and</em> has been approved.
            </p>

            {postError && (
              <div className="space-y-1">
                <p className={`text-xs flex items-center gap-1.5 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                  <Ban className="w-3.5 h-3.5 shrink-0" aria-hidden />
                  {postError}
                </p>
                {postErrorReconcile && postErrorReconcile.errors.length > 0 && (
                  <ul className="space-y-0.5 pl-5">
                    {postErrorReconcile.errors.map((e, i) => (
                      <li key={i} className={`text-xs ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                        {e}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {liveResult && (
              <div
                className={`rounded-lg border p-2.5 text-sm flex items-center gap-2 ${
                  darkMode ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden />
                <span>
                  Posted — QB entry <strong>{liveResult.qbEntryId ?? '—'}</strong>, doc number{' '}
                  <strong>{liveResult.qbDocNumber ?? '—'}</strong>.
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {!header && !loading && !error && (
        <p className={`text-sm ${subText}`}>Enter a draft id and click Load to reconcile, preview, approve, and post.</p>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

const STATUS_LABEL: Record<HeaderStatus, string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  approved: 'Approved',
  posted: 'Posted',
  error: 'Error',
};

function StatusBadge({ darkMode, status }: { darkMode: boolean; status: HeaderStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
        darkMode ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
