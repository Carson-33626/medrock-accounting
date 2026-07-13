'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { UnmappedColumnsPanel } from './UnmappedColumnsPanel';
import { MarketerReviewPanel } from './MarketerReviewPanel';
import { DirectionsBanner } from './DirectionsBanner';

/**
 * Local mirrors of the payroll API response shapes (web/src/lib/payroll/types.ts +
 * web/src/lib/payroll/store.ts PayrollHeader). Not imported directly — those modules
 * pull in the RDS pool (`pg`), which must never land in a client bundle.
 */
type PostingType = 'Debit' | 'Credit';
type LineOrigin = 'generated' | 'manual' | 'inter_entity';
type CreditBucket = 'Net Pay' | 'Taxes' | 'Garnishments' | 'Retirement' | 'Health' | 'WC' | 'Other';

interface JournalLine {
  postingType: PostingType;
  amount: number;
  accountName: string;
  departmentName: string | null;
  className: string | null;
  memo: string;
  creditBucket: CreditBucket | null;
  origin: LineOrigin;
  sourceRowKeys: string[];
}

interface PayrollHeader {
  id: number;
  entity: string;
  pay_date: string;
  pay_group: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  total_debits: number;
  total_credits: number;
  variance: number;
  row_count: number;
}

interface DraftResponse {
  header: PayrollHeader;
  lines: JournalLine[];
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

interface DrilldownResponse {
  row_key: string;
  position_id: string;
  name: string;
  pay_date: string;
  pay_group: string;
  sensitive: Record<string, number | string | null>;
}

/** Mirror of /api/payroll/roster RosterItem — plaintext only, no amounts. */
interface RosterItem {
  rowKey: string;
  name: string;
  positionId: string;
  payDate: string;
  payGroup: string;
}

interface ApiErrorBody {
  error?: string;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmtMoney = (n: number): string => usd.format(n);

const CREDIT_BUCKETS: CreditBucket[] = ['Net Pay', 'Taxes', 'Garnishments', 'Retirement', 'Health', 'WC', 'Other'];

/**
 * Drill-down source values are raw ADP numbers that carry floating-point tails
 * (12.639999999999999). Round to 4 dp then strip trailing zeros — kills the noise on
 * dollars (→ 12.64) while preserving genuine sub-cent precision on hours (0.0901, -0.0033).
 */
function fmtDetailValue(v: number | string | null): string {
  if (v === null) return '—';
  if (typeof v === 'number') return String(Number(v.toFixed(4)));
  return v;
}

let nextTempId = 0;
function withKey(line: JournalLine): JournalLine & { _key: number } {
  return { ...line, _key: nextTempId++ };
}

function blankLine(postingType: PostingType): JournalLine & { _key: number } {
  return withKey({
    postingType,
    amount: 0,
    accountName: '',
    departmentName: null,
    className: null,
    memo: '',
    creditBucket: null,
    origin: 'manual',
    sourceRowKeys: [],
  });
}

function stripKey(line: JournalLine & { _key: number }): JournalLine {
  const { _key: _unused, ...rest } = line;
  void _unused;
  return rest;
}

interface ReviewTabProps {
  /** The draft header to review — chosen by clicking a card on the Payrolls landing. */
  headerId: number;
  /** Switches PayrollTabs to the Mappings tab (optionally pre-selecting an entity). */
  onNavigateToMappings?: (entity: string) => void;
}

/** Review detail: auto-loads the selected draft, edits its lines with a live client-side balance, reconciles, and drills into source detail. */
export function ReviewTab({ headerId, onNavigateToMappings }: ReviewTabProps) {
  const { darkMode } = useDarkMode();

  const [header, setHeader] = useState<PayrollHeader | null>(null);
  const [lines, setLines] = useState<Array<JournalLine & { _key: number }>>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [personSearch, setPersonSearch] = useState<string>('');
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  const [drilldownKeyNotConfigured, setDrilldownKeyNotConfigured] = useState(false);
  const [drilldown, setDrilldown] = useState<DrilldownResponse | null>(null);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  // Shared by the manual "Reconcile" button and the automatic post-load reconcile below, so
  // unmapped columns (and the "New columns detected" panel) surface as soon as a run is loaded
  // rather than only after the accountant clicks Reconcile.
  const runReconcile = useCallback(async (id: number) => {
    setReconciling(true);
    setError(null);
    try {
      const res = await fetch('/api/payroll/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId: id }),
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
  }, []);

  const loadRoster = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/payroll/roster?headerId=${id}`);
      if (!res.ok) return; // roster is a convenience — never block the draft on it
      const body = (await res.json()) as RosterItem[];
      setRoster(body);
    } catch {
      // ignore — the drill-down just won't offer a picker
    }
  }, []);

  const loadDraft = useCallback(
    async (id: number) => {
      setLoading(true);
      setError(null);
      setReconcileResult(null);
      setRoster([]);
      setDrilldown(null);
      setActiveRowKey(null);
      let ok = false;
      try {
        const res = await fetch(`/api/payroll/run/${id}`);
        const body = (await res.json()) as DraftResponse & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setHeader(body.header);
        setLines(body.lines.map(withKey));
        ok = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load draft';
        setError(message);
        setHeader(null);
        setLines([]);
      } finally {
        setLoading(false);
      }
      if (ok) {
        await Promise.all([runReconcile(id), loadRoster(id)]);
      }
    },
    [runReconcile, loadRoster],
  );

  // Auto-load whenever the selected draft changes (i.e. a different card was clicked).
  useEffect(() => {
    void loadDraft(headerId);
  }, [headerId, loadDraft]);

  const updateLine = useCallback((key: number, patch: Partial<JournalLine>) => {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  }, []);

  const removeLine = useCallback((key: number) => {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }, []);

  const addLine = useCallback((postingType: PostingType) => {
    setLines((prev) => [...prev, blankLine(postingType)]);
  }, []);

  // Live balance — recomputed client-side on every edit.
  const totals = useMemo(() => {
    const totalDebits = round2(
      lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
    );
    const totalCredits = round2(
      lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
    );
    const variance = round2(totalDebits - totalCredits);
    return { totalDebits, totalCredits, variance };
  }, [lines]);

  const balanced = totals.variance === 0;

  const debitLines = useMemo(() => lines.filter((l) => l.postingType === 'Debit'), [lines]);
  const creditLines = useMemo(() => lines.filter((l) => l.postingType === 'Credit'), [lines]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/payroll/run/${headerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lines.map(stripKey) }),
      });
      const body = (await res.json()) as DraftResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setHeader(body.header);
      setLines(body.lines.map(withKey));
      setReconcileResult(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save draft';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [headerId, lines]);

  const handleReconcile = useCallback(() => {
    void runReconcile(headerId);
  }, [headerId, runReconcile]);

  const handleDrilldown = useCallback(async (rowKey: string) => {
    if (!rowKey) return;
    setActiveRowKey(rowKey);
    setDrilldownLoading(true);
    setDrilldownError(null);
    setDrilldownKeyNotConfigured(false);
    setDrilldown(null);
    try {
      const res = await fetch(`/api/payroll/drilldown?rowKey=${encodeURIComponent(rowKey)}`);
      if (res.status === 503) {
        setDrilldownKeyNotConfigured(true);
        return;
      }
      const body = (await res.json()) as DrilldownResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      // Do NOT log `body` — it carries decrypted per-employee detail.
      setDrilldown(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load source detail';
      setDrilldownError(message);
    } finally {
      setDrilldownLoading(false);
    }
  }, []);

  const filteredRoster = useMemo(() => {
    const q = personSearch.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((p) => p.name.toLowerCase().includes(q) || p.positionId.toLowerCase().includes(q));
  }, [roster, personSearch]);

  return (
    <div className="space-y-6">
      <DirectionsBanner darkMode={darkMode} title="How to review this payroll">
        <p>
          This is one entity&apos;s journal entry. Clear the worklists at the top first — <strong>map any new
          columns</strong> and <strong>assign any marketers</strong> flagged for a region. Then check the balance,
          edit lines if needed, and <strong>Save</strong>.
        </p>
        <p>
          When it&apos;s balanced and postable, use the <strong>Post</strong> panel below to preview, approve, and
          post it to QuickBooks.
        </p>
      </DirectionsBanner>

      {/* Loaded-draft summary — what this JE is + who it pays. */}
      <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-2`}>
        <div className="flex flex-wrap items-center gap-3">
          {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
          {header ? (
            <div className="text-sm">
              <span className="font-semibold">{header.entity}</span>
              <span className={subText}> · {header.pay_date} · {header.pay_group}</span>
            </div>
          ) : (
            <div className={`text-sm ${subText}`}>{loading ? 'Loading draft…' : 'Draft'}</div>
          )}
          {roster.length > 0 && (
            <span
              className={`text-xs rounded-full border px-2 py-0.5 ${
                darkMode ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'
              }`}
            >
              {roster.length} {roster.length === 1 ? 'person' : 'people'} paid
            </span>
          )}
        </div>
        {header && roster.length > 0 && (
          <p className={`text-xs ${subText}`}>
            <span className="font-medium">Paying:</span>{' '}
            {roster.slice(0, 12).map((p) => p.name).join(', ')}
            {roster.length > 12 ? `, +${roster.length - 12} more` : ''}
          </p>
        )}
      </div>

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

      {header && (
        <>
          {/* New columns detected — inline mapper worklist, resets per draft via `key`. */}
          <UnmappedColumnsPanel
            key={headerId}
            darkMode={darkMode}
            cardBg={cardBg}
            subText={subText}
            border={border}
            inputBg={inputBg}
            entity={header.entity}
            unmappedColumns={reconcileResult ? reconcileResult.unmappedColumns : null}
            onMapped={() => void runReconcile(headerId)}
            onNavigateToMappings={(ent) => onNavigateToMappings?.(ent)}
          />

          {/* Marketers needing region review — inline reassignment worklist, resets per draft via `key`. */}
          <MarketerReviewPanel
            key={headerId}
            darkMode={darkMode}
            cardBg={cardBg}
            subText={subText}
            border={border}
            inputBg={inputBg}
            entity={header.entity}
            headerId={headerId}
            onReassigned={() => void runReconcile(headerId)}
          />

          {/* Live balance banner */}
          <div className={`rounded-xl shadow-sm p-4 ${cardBg} flex flex-wrap items-center gap-4`}>
            <div>
              <p className={`text-xs ${subText}`}>Total debits</p>
              <p className="text-lg font-bold tabular-nums">{fmtMoney(totals.totalDebits)}</p>
            </div>
            <div>
              <p className={`text-xs ${subText}`}>Total credits</p>
              <p className="text-lg font-bold tabular-nums">{fmtMoney(totals.totalCredits)}</p>
            </div>
            <div
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
                balanced
                  ? darkMode
                    ? 'bg-emerald-950/60 text-emerald-200 border-emerald-800'
                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : darkMode
                    ? 'bg-red-950/60 text-red-200 border-red-800'
                    : 'bg-red-50 text-red-700 border-red-200'
              }`}
            >
              {balanced ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
              {balanced ? 'Balanced' : `Variance ${fmtMoney(totals.variance)}`}
            </div>

            <div className="ml-auto flex gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Save className="w-4 h-4" aria-hidden />}
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={handleReconcile}
                disabled={reconciling}
                className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {reconciling ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <CheckCircle2 className="w-4 h-4" aria-hidden />}
                {reconciling ? 'Reconciling…' : 'Reconcile'}
              </button>
            </div>
          </div>

          {/* Line editor */}
          <p className={`text-xs ${subText}`}>
            Fields marked <span className="text-red-500 font-semibold">*</span> are required to post — a line
            highlighted <span className="text-red-500 font-semibold">red</span> is missing an account or a positive amount.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <LineGroup
              title="Debits"
              postingType="Debit"
              darkMode={darkMode}
              cardBg={cardBg}
              subText={subText}
              border={border}
              inputBg={inputBg}
              lines={debitLines}
              onUpdate={updateLine}
              onRemove={removeLine}
              onAdd={() => addLine('Debit')}
            />
            <LineGroup
              title="Credits"
              postingType="Credit"
              darkMode={darkMode}
              cardBg={cardBg}
              subText={subText}
              border={border}
              inputBg={inputBg}
              lines={creditLines}
              onUpdate={updateLine}
              onRemove={removeLine}
              onAdd={() => addLine('Credit')}
            />
          </div>

          {/* Reconcile blockers panel */}
          {reconcileResult && (
            <ReconcilePanel darkMode={darkMode} cardBg={cardBg} subText={subText} border={border} result={reconcileResult} />
          )}

          {/* Drill-down — pick a person to see their source pay detail. */}
          <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Source detail — by person</p>
              {roster.length > 0 && (
                <div className="relative">
                  <Search className={`w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 ${subText}`} aria-hidden />
                  <input
                    type="text"
                    value={personSearch}
                    onChange={(e) => setPersonSearch(e.target.value)}
                    placeholder="Search person…"
                    className={`rounded-md border pl-7 pr-2 py-1 text-xs w-52 ${inputBg}`}
                  />
                </div>
              )}
            </div>

            {roster.length === 0 ? (
              <p className={`text-xs ${subText}`}>
                {loading ? 'Loading people…' : 'No people found for this run.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {filteredRoster.map((p) => {
                  const active = p.rowKey === activeRowKey;
                  return (
                    <button
                      key={p.rowKey}
                      onClick={() => void handleDrilldown(p.rowKey)}
                      disabled={drilldownLoading}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
                        active
                          ? 'bg-blue-600 text-white border-blue-600'
                          : darkMode
                            ? 'border-slate-600 hover:bg-slate-700'
                            : 'border-slate-300 hover:bg-slate-100'
                      }`}
                      title={`${p.name} · ${p.payGroup}`}
                    >
                      {p.name}
                    </button>
                  );
                })}
                {filteredRoster.length === 0 && (
                  <p className={`text-xs ${subText}`}>No one matches “{personSearch}”.</p>
                )}
              </div>
            )}

            {drilldownLoading && (
              <p className={`text-xs flex items-center gap-2 ${subText}`}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                Loading source detail…
              </p>
            )}

            {drilldownKeyNotConfigured && (
              <p className={`text-sm flex items-center gap-2 ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
                <Ban className="w-4 h-4 shrink-0" aria-hidden />
                Decrypt key not configured on this environment — source detail is unavailable.
              </p>
            )}
            {drilldownError && (
              <p className={`text-sm flex items-center gap-2 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
                <XCircle className="w-4 h-4 shrink-0" aria-hidden />
                {drilldownError}
              </p>
            )}
            {drilldown && (
              <div className={`rounded-lg border p-3 ${border} space-y-2`}>
                {/* Person · Date · Type — lead with the person, not the employee ID. */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold">{drilldown.name}</span>
                    <span className={`text-xs ${subText}`}>· {drilldown.pay_date}</span>
                    <span
                      className={`text-[11px] font-medium rounded-full border px-2 py-0.5 ${
                        darkMode ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      {drilldown.pay_group}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setDrilldown(null);
                      setActiveRowKey(null);
                    }}
                    aria-label="Close source detail"
                    title="Close"
                    className={`p-1 rounded-md shrink-0 ${darkMode ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-500 hover:bg-slate-100'}`}
                  >
                    <X className="w-4 h-4" aria-hidden />
                  </button>
                </div>
                {/* Amounts */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(drilldown.sensitive).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2 border-b border-dashed pb-0.5 last:border-0">
                      <span className={subText}>{k}</span>
                      <span className="tabular-nums font-medium">{fmtDetailValue(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {!header && !loading && !error && (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          This draft could not be loaded. Go back to Payrolls and pick another.
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function LineGroup({
  title,
  postingType,
  darkMode,
  cardBg,
  subText,
  border,
  inputBg,
  lines,
  onUpdate,
  onRemove,
  onAdd,
}: {
  title: string;
  postingType: PostingType;
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  inputBg: string;
  lines: Array<JournalLine & { _key: number }>;
  onUpdate: (key: number, patch: Partial<JournalLine>) => void;
  onRemove: (key: number) => void;
  onAdd: () => void;
}) {
  const total = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-3`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">
          {title} <span className={`font-normal ${subText}`}>({lines.length})</span>
        </p>
        <span className="text-sm font-semibold tabular-nums">{fmtMoney(total)}</span>
      </div>

      <div className="space-y-2">
        {lines.length === 0 && <p className={`text-xs ${subText}`}>No {title.toLowerCase()} lines.</p>}
        {lines.map((line) => (
          <LineRow
            key={line._key}
            darkMode={darkMode}
            border={border}
            inputBg={inputBg}
            subText={subText}
            line={line}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        ))}
      </div>

      <button
        onClick={onAdd}
        className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border ${
          darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
        }`}
      >
        <Plus className="w-3.5 h-3.5" aria-hidden />
        Add {postingType.toLowerCase()} line
      </button>
    </div>
  );
}

function LineRow({
  darkMode,
  border,
  inputBg,
  subText,
  line,
  onUpdate,
  onRemove,
}: {
  darkMode: boolean;
  border: string;
  inputBg: string;
  subText: string;
  line: JournalLine & { _key: number };
  onUpdate: (key: number, patch: Partial<JournalLine>) => void;
  onRemove: (key: number) => void;
}) {
  const editable = line.origin !== 'generated';
  // Fields QuickBooks requires for a successful post: an account and a positive amount.
  const accountMissing = line.accountName.trim() === '';
  const amountMissing = !(Number(line.amount) > 0);
  const reqRing = 'border-red-500 ring-1 ring-red-500';
  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${border}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="relative">
            <input
              type="text"
              value={line.accountName}
              onChange={(e) => onUpdate(line._key, { accountName: e.target.value })}
              placeholder="Account"
              disabled={!editable}
              className={`w-full rounded-md border pl-2 pr-5 py-1 text-sm ${inputBg} disabled:opacity-70 ${accountMissing ? reqRing : ''}`}
            />
            <span
              className="absolute right-2 top-1/2 -translate-y-1/2 text-red-500 text-sm pointer-events-none"
              title="Required to post"
            >
              *
            </span>
          </div>
          <input
            type="text"
            value={line.memo}
            onChange={(e) => onUpdate(line._key, { memo: e.target.value })}
            placeholder="Memo"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
          <input
            type="text"
            value={line.departmentName ?? ''}
            onChange={(e) => onUpdate(line._key, { departmentName: e.target.value || null })}
            placeholder="Department"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
          <input
            type="text"
            value={line.className ?? ''}
            onChange={(e) => onUpdate(line._key, { className: e.target.value || null })}
            placeholder="Class"
            className={`rounded-md border px-2 py-1 text-sm ${inputBg}`}
          />
        </div>
        <button
          onClick={() => onRemove(line._key)}
          className={`p-1.5 rounded-md ${darkMode ? 'text-red-300 hover:bg-red-950/40' : 'text-red-600 hover:bg-red-50'}`}
          aria-label="Remove line"
          title="Remove line"
        >
          <Trash2 className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className={`text-xs ${subText} flex items-center gap-1`}>
          Amount <span className="text-red-500" title="Required to post">*</span>
          <input
            type="number"
            step="0.01"
            value={line.amount}
            onChange={(e) => onUpdate(line._key, { amount: Number(e.target.value) })}
            className={`w-28 rounded-md border px-2 py-1 text-sm tabular-nums ${inputBg} ${amountMissing ? reqRing : ''}`}
          />
        </label>

        <select
          value={line.creditBucket ?? ''}
          onChange={(e) => onUpdate(line._key, { creditBucket: (e.target.value || null) as CreditBucket | null })}
          className={`rounded-md border px-2 py-1 text-xs ${inputBg}`}
        >
          <option value="">Bucket…</option>
          {CREDIT_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        <select
          value={line.origin}
          onChange={(e) => onUpdate(line._key, { origin: e.target.value as LineOrigin })}
          disabled={line.origin === 'generated'}
          className={`rounded-md border px-2 py-1 text-xs ${inputBg} disabled:opacity-70`}
        >
          <option value="generated">generated</option>
          <option value="manual">manual</option>
          <option value="inter_entity">inter_entity</option>
        </select>

        {line.sourceRowKeys.length > 0 && (
          <span className={`text-[11px] ${subText}`}>{line.sourceRowKeys.length} source row{line.sourceRowKeys.length === 1 ? '' : 's'}</span>
        )}
      </div>
    </div>
  );
}

function ReconcilePanel({
  darkMode,
  cardBg,
  subText,
  border,
  result,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  result: ReconcileResult;
}) {
  const checks: Array<{ label: string; ok: boolean }> = [
    { label: 'Balanced', ok: result.balanced },
    { label: 'Gross OK', ok: result.grossOk },
    { label: 'Net OK', ok: result.netOk },
    { label: 'Taxes (EE) OK', ok: result.taxesEeOk },
    { label: 'Taxes (ER) OK', ok: result.taxesErOk },
  ];

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-4`}>
      <div className="flex items-center justify-between">
        <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Reconcile</p>
        <div
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
            result.postable
              ? darkMode
                ? 'bg-emerald-950/60 text-emerald-200 border-emerald-800'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : darkMode
                ? 'bg-red-950/60 text-red-200 border-red-800'
                : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {result.postable ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <XCircle className="w-3.5 h-3.5" aria-hidden />}
          {result.postable ? 'Postable' : 'Not postable'}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {checks.map((c) => (
          <div key={c.label} className={`rounded-lg border p-2 text-xs flex items-center gap-1.5 ${border}`}>
            {c.ok ? (
              <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`} aria-hidden />
            ) : (
              <XCircle className={`w-3.5 h-3.5 shrink-0 ${darkMode ? 'text-red-300' : 'text-red-600'}`} aria-hidden />
            )}
            {c.label}
          </div>
        ))}
      </div>

      {(result.unmappedColumns.length > 0 || result.unmappedPositions.length > 0) && (
        <div className={`pt-3 border-t ${border} grid grid-cols-1 sm:grid-cols-2 gap-4`}>
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>
              Unmapped columns ({result.unmappedColumns.length})
            </p>
            {result.unmappedColumns.length === 0 ? (
              <p className={`text-xs mt-1 ${subText}`}>None.</p>
            ) : (
              <p className={`text-xs mt-1 ${subText}`}>{result.unmappedColumns.join(', ')}</p>
            )}
          </div>
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>
              Unmapped positions ({result.unmappedPositions.length})
            </p>
            {result.unmappedPositions.length === 0 ? (
              <p className={`text-xs mt-1 ${subText}`}>None.</p>
            ) : (
              <p className={`text-xs mt-1 ${subText}`}>{result.unmappedPositions.join(', ')}</p>
            )}
          </div>
        </div>
      )}

      {result.errors.length > 0 && (
        <ul className={`pt-3 border-t ${border} space-y-1`}>
          {result.errors.map((e, i) => (
            <li key={i} className={`text-sm flex items-start gap-2 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              <span>{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
