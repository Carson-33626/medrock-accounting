'use client';

import { useCallback, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { AlertTriangle, Ban, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

/**
 * Local mirrors of the /api/payroll/runs response shape (web/src/lib/payroll/store.ts
 * PayrollHeader + web/src/lib/payroll/build-je.ts ExcludedGroup). Not imported directly —
 * those modules pull in the RDS pool (`pg`), which must never land in a client bundle.
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

interface ApiErrorBody {
  error?: string;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtMoney(n: number): string {
  return usd.format(n);
}

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

/** Runs tab: pick a date range, build per-entity draft JEs, review balances/unmapped/excluded. */
export function RunsTab() {
  const { darkMode } = useDarkMode();
  const [start, setStart] = useState<string>(firstOfMonthIso());
  const [end, setEnd] = useState<string>(todayIso());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunsBuildResponse | null>(null);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const buildDrafts = useCallback(async () => {
    setLoading(true);
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
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to build payroll drafts';
      setError(message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className={`rounded-xl shadow-sm p-4 ${cardBg} flex flex-wrap items-end gap-3`}>
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
          onClick={() => void buildDrafts()}
          disabled={loading}
          className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="w-4 h-4" aria-hidden />
          )}
          {loading ? 'Building…' : 'Build drafts'}
        </button>
      </div>

      {loading && !result && (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          Reading ADP payroll history and building per-entity drafts…
        </div>
      )}

      {error && (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-red-950/40 border-red-800 text-red-200' : 'bg-red-50 border-red-300 text-red-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            <strong>Build failed:</strong> {error}
          </p>
        </div>
      )}

      {result && (
        <>
          <SummaryPanel darkMode={darkMode} cardBg={cardBg} subText={subText} border={border} result={result} />

          {result.headers.length === 0 ? (
            <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
              No draft journal entries for this range.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {result.headers.map((h) => (
                <RunCard key={h.id} darkMode={darkMode} cardBg={cardBg} subText={subText} border={border} header={h} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SummaryPanel({
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
  result: RunsBuildResponse;
}) {
  const columnsPreview = result.unmappedColumns.slice(0, 8);
  const positionsPreview = result.unmappedPositions.slice(0, 8);

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} space-y-4`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Unmapped ADP columns</p>
          <p className="text-lg font-bold mt-1">{result.unmappedColumns.length}</p>
          {columnsPreview.length > 0 && (
            <p className={`text-xs mt-1 ${subText}`}>
              {columnsPreview.join(', ')}
              {result.unmappedColumns.length > columnsPreview.length ? ', …' : ''}
            </p>
          )}
        </div>
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Unmapped positions</p>
          <p className="text-lg font-bold mt-1">{result.unmappedPositions.length}</p>
          {positionsPreview.length > 0 && (
            <p className={`text-xs mt-1 ${subText}`}>
              {positionsPreview.join(', ')}
              {result.unmappedPositions.length > positionsPreview.length ? ', …' : ''}
            </p>
          )}
        </div>
      </div>

      <div className={`pt-3 border-t ${border}`}>
        <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>
          Excluded pay groups ({result.excluded.length})
        </p>
        {result.excluded.length === 0 ? (
          <p className={`text-sm mt-1 ${subText}`}>None excluded in this range.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {result.excluded.map((g) => (
              <li
                key={g.payGroup}
                className={`text-sm flex items-start gap-2 ${darkMode ? 'text-amber-200' : 'text-amber-800'}`}
              >
                <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                <span>
                  <strong>{g.payGroup}</strong> — {g.reason} ({g.count} row{g.count === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunCard({
  darkMode,
  cardBg,
  subText,
  border,
  header,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  header: PayrollHeader;
}) {
  const balanced = header.variance === 0;
  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} border ${border} space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{header.entity}</p>
          <p className={`text-xs ${subText}`}>
            {header.pay_date} · {header.pay_group}
          </p>
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
        {balanced ? (
          <CheckCircle2 className="w-3 h-3" aria-hidden />
        ) : (
          <AlertTriangle className="w-3 h-3" aria-hidden />
        )}
        {balanced ? 'Balanced' : `Variance ${fmtMoney(header.variance)}`}
      </div>
    </div>
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
