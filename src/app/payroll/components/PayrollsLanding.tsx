'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { DirectionsBanner } from './DirectionsBanner';

/**
 * Local mirrors of the /api/payroll/runs response shapes (store.ts PayrollHeader +
 * build-je.ts ExcludedGroup). Not imported directly — those modules pull in the RDS
 * pool (`pg`), which must never land in a client bundle.
 */
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

interface ExcludedGroup {
  payGroup: string;
  reason: string;
  count: number;
}

interface RunsBuildResponse {
  headers: PayrollHeader[];
  unmappedColumns: string[];
  unmappedPositions: string[];
  excluded: ExcludedGroup[];
}

interface RecentResponse {
  headers: PayrollHeader[];
}

interface ApiErrorBody {
  error?: string;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (n: number): string => usd.format(n);

function firstOfMonthIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  approved: 'Approved',
  posted: 'Posted',
  error: 'Error',
};

interface PayrollsLandingProps {
  /** Open a draft's Review/Post detail view. */
  onOpen: (headerId: number) => void;
}

/**
 * `/payroll` landing: the most recent pay periods, already populated and clickable.
 * No "generate first" gate — recent runs load on mount. A collapsed panel lets the
 * accountant import/build a new pay period on demand.
 */
export function PayrollsLanding({ onOpen }: PayrollsLandingProps) {
  const { darkMode } = useDarkMode();

  const [periods, setPeriods] = useState(2);
  const [headers, setHeaders] = useState<PayrollHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  const loadRecent = useCallback(async (n: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/payroll/runs?recent=${n}`);
      const body = (await res.json()) as RecentResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setHeaders(body.headers);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load recent payrolls';
      setError(message);
      setHeaders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecent(periods);
  }, [periods, loadRecent]);

  // Group headers by pay_date (already newest-first from the API).
  const groups = useMemo(() => {
    const byDate = new Map<string, PayrollHeader[]>();
    for (const h of headers) {
      const list = byDate.get(h.pay_date) ?? [];
      list.push(h);
      byDate.set(h.pay_date, list);
    }
    return [...byDate.entries()];
  }, [headers]);

  return (
    <div className="space-y-6">
      <DirectionsBanner darkMode={darkMode} title="How payrolls work">
        <p>
          Each card below is one entity&apos;s journal entry for a pay period. <strong>Click a card</strong> to
          review its lines, fix any unmapped items, and post it to QuickBooks.
        </p>
        <p>
          The two most recent pay periods load automatically. Need an older or brand-new period? Use{' '}
          <strong>Import a pay period</strong> below to pull it from ADP.
        </p>
      </DirectionsBanner>

      <ImportPanel darkMode={darkMode} onImported={() => void loadRecent(periods)} />

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

      {loading && headers.length === 0 ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" aria-hidden />
          Loading recent payrolls…
        </div>
      ) : groups.length === 0 ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          No payrolls yet. Use <strong>Import a pay period</strong> above to build your first draft.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(([payDate, list]) => (
            <div key={payDate} className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Pay date {payDate}</h2>
                <span className={`text-xs ${subText}`}>
                  {list.length} {list.length === 1 ? 'entity' : 'entities'}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {list.map((h) => (
                  <RunCard
                    key={h.id}
                    darkMode={darkMode}
                    cardBg={cardBg}
                    subText={subText}
                    border={border}
                    header={h}
                    onOpen={() => onOpen(h.id)}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="flex justify-center">
            <button
              onClick={() => setPeriods((p) => p + 2)}
              disabled={loading}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
              Show more pay periods
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Import / build panel (collapsed by default) ─────────────────────────────

function ImportPanel({ darkMode, onImported }: { darkMode: boolean; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<string>(firstOfMonthIso());
  const [end, setEnd] = useState<string>(todayIso());
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunsBuildResponse | null>(null);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch('/api/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end }),
      });
      const body = (await res.json()) as RunsBuildResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setResult(body);
      onImported();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to import pay period';
      setError(message);
      setResult(null);
    } finally {
      setBuilding(false);
    }
  }, [start, end, onImported]);

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-4 text-left text-sm font-semibold"
      >
        <Plus className="w-4 h-4 shrink-0" aria-hidden />
        <span className="flex-1">Import a pay period</span>
        {open ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
      </button>

      {open && (
        <div className={`px-4 pb-4 space-y-4 border-t ${border} pt-4`}>
          <p className={`text-xs ${subText}`}>
            Pick the date range covering the ADP pay date(s) you want to pull. Building drafts is safe — it reads ADP
            and writes drafts only; nothing posts to QuickBooks.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className={`text-sm ${subText}`}>
              Start
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={`block mt-1 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}
              />
            </label>
            <label className={`text-sm ${subText}`}>
              End
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className={`block mt-1 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}
              />
            </label>
            <button
              onClick={() => void build()}
              disabled={building}
              className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {building ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
              {building ? 'Building…' : 'Build drafts'}
            </button>
          </div>

          {error && (
            <p className={`text-sm flex items-center gap-2 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          {result && (
            <div className={`rounded-lg border p-3 ${border} text-sm space-y-2`}>
              <p className="flex items-center gap-2">
                <CheckCircle2 className={`w-4 h-4 ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`} aria-hidden />
                Built {result.headers.length} draft{result.headers.length === 1 ? '' : 's'} — they now appear in the list below.
              </p>
              {result.unmappedColumns.length > 0 && (
                <p className={subText}>
                  {result.unmappedColumns.length} unmapped column{result.unmappedColumns.length === 1 ? '' : 's'} — resolve
                  inside each draft&apos;s Review.
                </p>
              )}
              {result.excluded.length > 0 && (
                <ul className="space-y-1">
                  {result.excluded.map((g) => (
                    <li key={g.payGroup} className={`flex items-start gap-2 ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}>
                      <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                      <span>
                        <strong>{g.payGroup}</strong> — {g.reason} ({g.count} row{g.count === 1 ? '' : 's'})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Run card (clickable) ────────────────────────────────────────────────────

function RunCard({
  darkMode,
  cardBg,
  subText,
  border,
  header,
  onOpen,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  header: PayrollHeader;
  onOpen: () => void;
}) {
  const balanced = header.variance === 0;
  return (
    <button
      onClick={onOpen}
      className={`text-left rounded-xl shadow-sm p-4 ${cardBg} border ${border} space-y-3 transition-shadow hover:shadow-md hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{header.entity}</p>
          <p className={`text-xs ${subText}`}>{header.pay_group}</p>
        </div>
        <StatusBadge darkMode={darkMode} status={header.status} />
      </div>

      <div className={`text-xs ${subText}`}>
        {header.row_count} row{header.row_count === 1 ? '' : 's'}
        {header.period_start && header.period_end ? ` · period ${header.period_start}–${header.period_end}` : ''}
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className={`text-xs ${subText}`}>Debits</p>
          <p className="font-semibold tabular-nums">{fmtMoney(header.total_debits)}</p>
        </div>
        <div>
          <p className={`text-xs ${subText}`}>Credits</p>
          <p className="font-semibold tabular-nums">{fmtMoney(header.total_credits)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            balanced
              ? darkMode
                ? 'bg-emerald-950/60 text-emerald-200 border-emerald-800'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : darkMode
                ? 'bg-red-950/60 text-red-200 border-red-800'
                : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {balanced ? <CheckCircle2 className="w-3 h-3" aria-hidden /> : <AlertTriangle className="w-3 h-3" aria-hidden />}
          {balanced ? 'Balanced' : `Variance ${fmtMoney(header.variance)}`}
        </div>
        <span className={`text-xs font-medium ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>Open →</span>
      </div>
    </button>
  );
}

function StatusBadge({ darkMode, status }: { darkMode: boolean; status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
        darkMode ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {label}
    </span>
  );
}
