'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import StatusBadge from '@/components/PayrollStatusBadge';
import {
  AlertTriangle,
  Ban,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { DirectionsBanner } from './DirectionsBanner';
import { periodToRange, type PeriodGranularity } from '@/lib/payroll/accounting-period';

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
  period_segment: string;
  txn_date: string | null;
  kind: string;
  /** Total pieces in this run, counted server-side independently of any date filter. */
  piece_count: number;
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
  /** Distinct pay dates with built drafts. Absent on the explicit-range response. */
  totalPayDates?: number;
}

/** An explicit date range the list is pinned to, instead of the recent-N window. */
interface DateRange {
  start: string;
  end: string;
}

interface ApiErrorBody {
  error?: string;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (n: number): string => usd.format(n);
const round2 = (n: number): number => Math.round(n * 100) / 100;

function firstOfMonthIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sort key for an ADP MM/DD/YYYY pay_date string. NaN-safe: unparseable sorts last. */
function payDateMs(payDate: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(payDate);
  if (!m) return Number.NEGATIVE_INFINITY;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
}

/** MM/DD/YYYY for display of an ISO YYYY-MM-DD range bound. */
function isoToUs(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Jun' for '2026-06' (client-side mirror of split.ts pieceLabel — no server imports here). */
function segmentLabel(segment: string): string {
  const m = /^\d{4}-(\d{2})$/.exec(segment);
  return m ? SHORT_MONTHS[Number(m[1]) - 1] : segment;
}

/**
 * True when an MM/DD/YYYY period spans more than one calendar month, i.e. the run SHOULD post as
 * two journal entries (one per month). A straddling run that is not split is a real accounting
 * problem, not a display quirk: splitStraddle deliberately leaves an UNBALANCED draft whole
 * (split.ts), so a variance silently parks the entire period's expense in the pay-date month.
 * As of 2026-08-07 that had happened to seven runs, three of them off by five figures.
 */
function straddlesMonths(start: string | null, end: string | null): boolean {
  const s = start ? /^(\d{2})\/\d{2}\/(\d{4})$/.exec(start) : null;
  const e = end ? /^(\d{2})\/\d{2}\/(\d{4})$/.exec(end) : null;
  if (!s || !e) return false;
  return s[1] !== e[1] || s[2] !== e[2];
}


interface PayrollsLandingProps {
  /** Open a draft's Review/Post detail view. */
  onOpen: (headerId: number) => void;
}

/** sessionStorage key for the landing's view state (periods window + period filter). */
const FILTER_STORAGE_KEY = 'payroll-landing-view';

/**
 * `/payroll` landing: the most recent pay periods, already populated and clickable.
 * No "generate first" gate — recent runs load on mount. A collapsed panel lets the
 * accountant import/build a new pay period on demand.
 */
export function PayrollsLanding({ onOpen }: PayrollsLandingProps) {
  const { darkMode } = useDarkMode();

  // Show several recent pay dates by default: off-cycle 1-person "Anytime"/bonus runs create
  // extra pay dates, so a window of 2 would bury the real bi-weekly payroll behind "Show more".
  const [periods, setPeriods] = useState(6);
  const [headers, setHeaders] = useState<PayrollHeader[]>([]);
  const [totalPayDates, setTotalPayDates] = useState<number | null>(null);
  // When set, the list shows exactly this range instead of the recent-N window.
  // Importing an older pay period pins the list to it — otherwise the drafts build
  // fine but fall outside the recency window, so the list below appears unchanged.
  const [range, setRange] = useState<DateRange | null>(null);
  // Non-null when the current range came from the accounting-period filter (vs. an import) —
  // drives the period summary bar + its label. Kept alongside `range` so both banners stay distinct.
  const [periodLabel, setPeriodLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The landing unmounts when a card opens the Review/Post view; without persistence the
  // accountant's period filter resets on every return trip (Carson, 2026-08-19: post one
  // entity's 4/10 payroll, come back, still be looking at the 4/10 view). sessionStorage
  // scopes the memory to the tab; `restored` holds the first fetch until hydration-safe
  // restore has run, so the list never flashes the unfiltered recent-N view first.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { periods?: number; range?: DateRange | null; periodLabel?: string | null };
        if (typeof saved.periods === 'number' && Number.isFinite(saved.periods)) setPeriods(saved.periods);
        if (saved.range && typeof saved.range.start === 'string' && typeof saved.range.end === 'string') setRange(saved.range);
        if (typeof saved.periodLabel === 'string') setPeriodLabel(saved.periodLabel);
      }
    } catch {
      // corrupt/unavailable storage: fall through to defaults
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ periods, range, periodLabel }));
    } catch {
      // storage full/unavailable: the filter just won't stick
    }
  }, [restored, periods, range, periodLabel]);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  const load = useCallback(async (n: number, r: DateRange | null) => {
    setLoading(true);
    setError(null);
    try {
      const url = r
        ? `/api/payroll/runs?start=${encodeURIComponent(r.start)}&end=${encodeURIComponent(r.end)}`
        : `/api/payroll/runs?recent=${n}`;
      const res = await fetch(url);
      const body = (await res.json()) as RecentResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setHeaders(body.headers);
      setTotalPayDates(body.totalPayDates ?? null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payrolls';
      setError(message);
      setHeaders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!restored) return; // wait for the saved filter so we never fetch-then-refetch
    void load(periods, range);
  }, [restored, periods, range, load]);

  // Group headers by pay_date. The API already sorts newest-first, but sort here too
  // rather than depending on SQL order surviving JSON — pay_date is an MM/DD/YYYY
  // string, so it must be parsed, not compared lexicographically.
  const groups = useMemo(() => {
    const byDate = new Map<string, PayrollHeader[]>();
    for (const h of headers) {
      // Belt-and-suspenders: month-end allocation headers (kind === 'allocation') live on the
      // End of Month tab, not here — the store's /api/payroll/runs query already excludes them,
      // this just guards against a future query regression surfacing them on this list too.
      if (h.kind === 'allocation') continue;
      const list = byDate.get(h.pay_date) ?? [];
      list.push(h);
      byDate.set(h.pay_date, list);
    }
    return [...byDate.entries()].sort(
      ([a], [b]) => payDateMs(b) - payDateMs(a),
    );
  }, [headers]);

  // In recent-N mode we page until we hold every pay date that has drafts.
  const hasMore = range === null && totalPayDates !== null && groups.length < totalPayDates;

  // Totals across every draft in the currently-loaded set — surfaced when an accounting period
  // is selected so the accountant sees the period's debit/credit/balance rollup, not just cards.
  const periodTotals = useMemo(() => {
    const debits = round2(headers.reduce((s, h) => s + h.total_debits, 0));
    const credits = round2(headers.reduce((s, h) => s + h.total_credits, 0));
    return { debits, credits, variance: round2(debits - credits), drafts: headers.length, entities: new Set(headers.map((h) => h.entity)).size };
  }, [headers]);

  // Apply an accounting-period filter: pin the list to the period's date bounds (reusing the
  // range fetch) and remember the label for the summary bar.
  const applyPeriod = useCallback((start: string, end: string, label: string) => {
    setRange({ start, end });
    setPeriodLabel(label);
  }, []);

  const clearFilters = useCallback(() => {
    setRange(null);
    setPeriodLabel(null);
  }, []);

  return (
    <div className="space-y-6">
      <DirectionsBanner darkMode={darkMode} title="How payrolls work">
        <p>
          Each card below is one entity&apos;s journal entry for a pay period. <strong>Click a card</strong> to
          review its lines, fix any unmapped items, and post it to QuickBooks.
        </p>
        <p>
          Recent pay periods load automatically — including small off-cycle runs (a bonus or a one-off
          &ldquo;Anytime&rdquo; payment show up as their own 1-person card). Need an older or brand-new period? Use{' '}
          <strong>Import a pay period</strong> below to pull it from ADP.
        </p>
        <p>
          Four entities build drafts: <strong>MedRock FL</strong>, <strong>TN</strong>,{' '}
          <strong>TX</strong> and <strong>FOCAS</strong>. Not every entity appears on every pay
          date — a card only exists where ADP had rows for that pay group.
        </p>
        <p>
          A card with a <strong>Split</strong> badge is a payroll whose pay period crosses a month
          boundary: it posts as <strong>two journal entries</strong>, one per calendar month, and the
          card lists each month&apos;s share. Open it to review the pieces on sub-tabs — they approve
          and post together as a pair. Filtering by an accounting period can show just one of the two
          pieces; the badge then reads <em>(1 of 2)</em> and the total is labelled{' '}
          <strong>Shown here</strong> rather than Combined, so a part is never mistaken for the whole.
        </p>
        <p>
          An <strong>amber warning</strong> on a card means the opposite problem: the period crosses a
          month boundary but only one entry was produced, so the earlier month&apos;s share is sitting
          in the wrong month. That happens when the draft doesn&apos;t balance — a run is only split
          once its variance is zero. Clear the variance, then rebuild the period to split it.
        </p>
      </DirectionsBanner>

      <ImportPanel
        darkMode={darkMode}
        onImported={(start, end) => {
          setRange({ start, end });
          setPeriodLabel(null);
        }}
      />

      <PeriodFilter darkMode={darkMode} onApply={applyPeriod} />

      {range && periodLabel === null && (
        <div
          className={`rounded-xl border p-3 flex flex-wrap gap-2 items-center text-sm ${
            darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-blue-50 border-blue-200 text-blue-900'
          }`}
        >
          <CalendarRange className="w-4 h-4 shrink-0" aria-hidden />
          <span>
            Showing imported pay periods <strong>{isoToUs(range.start)}</strong> –{' '}
            <strong>{isoToUs(range.end)}</strong>
            {!loading && ` · ${groups.length} pay date${groups.length === 1 ? '' : 's'}`}
          </span>
          <button
            onClick={clearFilters}
            className={`ml-auto underline underline-offset-2 ${darkMode ? 'text-slate-300' : 'text-blue-800'}`}
          >
            Back to recent payrolls
          </button>
        </div>
      )}

      {periodLabel !== null && (
        <PeriodSummary
          darkMode={darkMode}
          label={periodLabel}
          totals={periodTotals}
          loading={loading}
          onClear={clearFilters}
        />
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

      {loading && headers.length === 0 ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" aria-hidden />
          Loading recent payrolls…
        </div>
      ) : groups.length === 0 ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          {range ? (
            <>
              No drafts built for {isoToUs(range.start)} – {isoToUs(range.end)}. ADP may have no pay dates in
              that range — widen it and build again.
            </>
          ) : (
            <>
              No payrolls yet. Use <strong>Import a pay period</strong> above to build your first draft.
            </>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(([payDate, list]) => {
            const runs = new Map<string, PayrollHeader[]>();
            for (const h of list) {
              const k = `${h.entity}|${h.pay_group}`;
              const cur = runs.get(k) ?? [];
              cur.push(h);
              runs.set(k, cur);
            }
            const runList = [...runs.values()].map((pieces) =>
              [...pieces].sort((a, b) => a.period_segment.localeCompare(b.period_segment)),
            );
            return (
              <div key={payDate} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Pay date {payDate}</h2>
                  <span className={`text-xs ${subText}`}>
                    {list.length} {list.length === 1 ? 'entity' : 'entities'}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {runList.map((pieces) => (
                    <RunCard
                      key={pieces[0].id}
                      darkMode={darkMode}
                      cardBg={cardBg}
                      subText={subText}
                      border={border}
                      pieces={pieces}
                      onOpen={() => onOpen(pieces[0].id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          <div className={`flex flex-col items-center gap-2 text-xs ${subText}`}>
            {hasMore ? (
              <button
                onClick={() => setPeriods((p) => p + 6)}
                disabled={loading}
                className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-200 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
                Show more pay periods
              </button>
            ) : null}
            {range === null && totalPayDates !== null && (
              <p>
                {hasMore
                  ? `Showing ${groups.length} of ${totalPayDates} pay dates with drafts.`
                  : `Showing all ${totalPayDates} pay date${totalPayDates === 1 ? '' : 's'} that have drafts.`}
                {' '}Older period not listed? Use <strong>Import a pay period</strong> above to pull it from ADP.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Import / build panel (collapsed by default) ─────────────────────────────

function ImportPanel({
  darkMode,
  onImported,
}: {
  darkMode: boolean;
  /** Pins the landing list to the range just imported, so the new drafts are visible. */
  onImported: (start: string, end: string) => void;
}) {
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
      onImported(start, end);
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
  pieces,
  onOpen,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  pieces: PayrollHeader[];
  onOpen: () => void;
}) {
  const header = pieces[0];
  // Whether the run IS split comes from the server-side piece_count, never from how many
  // siblings this query returned. Under a month filter only one piece of a split run comes
  // back (the pieces post in different months), and inferring `pieces.length > 1` there both
  // hid the Split badge AND presented one piece's debits/credits as if they were the whole
  // run's — the dangerous half of the bug. See store.listHeaders.
  const split = (header.piece_count ?? pieces.length) > 1;
  // True when the run is split but this view is only showing some of its pieces.
  const partial = split && pieces.length < (header.piece_count ?? pieces.length);
  const balanced = pieces.every((p) => p.variance === 0);
  const status = split ? (pieces.find((p) => p.status !== 'posted')?.status ?? 'posted') : header.status;
  const combinedVariance = round2(pieces.reduce((s, p) => s + p.variance, 0));
  // A period crossing a month boundary that produced only ONE entry never got split. The cause is
  // almost always the variance below (splitStraddle refuses to split an unbalanced draft), and the
  // consequence is that the prior month's share of this payroll posts in the wrong month.
  const shouldHaveSplit = !split && straddlesMonths(header.period_start, header.period_end);
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
        <div className="flex items-center gap-1">
          {split && (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                darkMode ? 'bg-indigo-950/60 text-indigo-200 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
              }`}
            >
              Split · {pieces.map((p) => segmentLabel(p.period_segment)).join('/')}
              {partial && ` (${pieces.length} of ${header.piece_count})`}
            </span>
          )}
          <StatusBadge darkMode={darkMode} status={status} />
        </div>
      </div>

      <div className={`text-xs ${subText}`}>
        {header.row_count} row{header.row_count === 1 ? '' : 's'}
        {header.period_start && header.period_end ? ` · period ${header.period_start}–${header.period_end}` : ''}
      </div>

      {shouldHaveSplit && (
        <p
          className={`text-[11px] flex items-start gap-1 rounded-md border px-2 py-1 ${
            darkMode ? 'bg-amber-950/50 text-amber-200 border-amber-800' : 'bg-amber-50 text-amber-800 border-amber-200'
          }`}
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
          <span>
            This period crosses a month boundary but posted as <strong>one</strong> entry — the earlier
            month&apos;s share will land in the wrong month.
            {!balanced && ' Clear the variance below, then rebuild to split it.'}
          </span>
        </p>
      )}

      {split ? (
        <div className="space-y-1 text-sm">
          {pieces.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2">
              <span className={`text-xs ${subText}`}>{segmentLabel(p.period_segment)} ({p.txn_date ?? p.pay_date})</span>
              <span className="tabular-nums font-medium">{fmtMoney(p.total_debits)}</span>
            </div>
          ))}
          <div className={`flex items-center justify-between gap-2 border-t pt-1 ${border}`}>
            {/* Only the pieces in view are summed, so label it honestly rather than calling a
                partial sum "Combined" — under a month filter that would understate the run. */}
            <span className={`text-xs font-semibold ${subText}`}>{partial ? 'Shown here' : 'Combined'}</span>
            <span className="tabular-nums font-semibold">{fmtMoney(round2(pieces.reduce((s, p) => s + p.total_debits, 0)))}</span>
          </div>
          {partial && (
            <p className={`text-[11px] ${subText}`}>
              The other {header.piece_count - pieces.length} piece
              {header.piece_count - pieces.length === 1 ? '' : 's'} post{header.piece_count - pieces.length === 1 ? 's' : ''} in
              another month and {header.piece_count - pieces.length === 1 ? 'is' : 'are'} outside this filter. Open to see the whole run.
            </p>
          )}
        </div>
      ) : (
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
      )}

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
          {balanced ? 'Balanced' : `Variance ${fmtMoney(split ? combinedVariance : header.variance)}`}
        </div>
        <span className={`text-xs font-medium ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>Open →</span>
      </div>
    </button>
  );
}


// ── Accounting-period filter (collapsed by default) ─────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GRANULARITIES: readonly PeriodGranularity[] = ['month', 'quarter', 'year'];

function PeriodFilter({
  darkMode,
  onApply,
}: {
  darkMode: boolean;
  /** Pin the landing list to the selected accounting period's date bounds. */
  onApply: (start: string, end: string, label: string) => void;
}) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const [open, setOpen] = useState(false);
  const [granularity, setGranularity] = useState<PeriodGranularity>('month');
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const years = [currentYear, currentYear - 1, currentYear - 2];

  const apply = useCallback(() => {
    const r = periodToRange(granularity, year, { month, quarter });
    onApply(r.start, r.end, r.label);
  }, [granularity, year, month, quarter, onApply]);

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 p-4 text-left text-sm font-semibold">
        <Filter className="w-4 h-4 shrink-0" aria-hidden />
        <span className="flex-1">Filter by accounting period</span>
        {open ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
      </button>

      {open && (
        <div className={`px-4 pb-4 space-y-3 border-t ${border} pt-4`}>
          <p className={`text-xs ${subText}`}>
            Show the journal entries whose posting date (TxnDate) falls in a month, quarter, or year — a split
            payroll&apos;s prior-month piece shows under the month it expenses into.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="inline-flex rounded-lg border overflow-hidden">
              {GRANULARITIES.map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize ${
                    granularity === g
                      ? 'bg-blue-600 text-white'
                      : darkMode ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>

            {granularity === 'month' && (
              <label className={`text-xs ${subText}`}>
                Month
                <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={`block mt-0.5 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}>
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>{name}</option>
                  ))}
                </select>
              </label>
            )}

            {granularity === 'quarter' && (
              <label className={`text-xs ${subText}`}>
                Quarter
                <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className={`block mt-0.5 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}>
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>Q{q}</option>
                  ))}
                </select>
              </label>
            )}

            <label className={`text-xs ${subText}`}>
              Year
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={`block mt-0.5 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>

            <button
              onClick={apply}
              className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              <Filter className="w-4 h-4" aria-hidden />
              Apply filter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Period totals summary (shown while a period filter is active) ────────────

function PeriodSummary({
  darkMode,
  label,
  totals,
  loading,
  onClear,
}: {
  darkMode: boolean;
  label: string;
  totals: { debits: number; credits: number; variance: number; drafts: number; entities: number };
  loading: boolean;
  onClear: () => void;
}) {
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const balanced = totals.variance === 0;
  return (
    <div className={`rounded-xl border p-3 space-y-2 ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-blue-50 border-blue-200 text-blue-900'}`}>
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <CalendarRange className="w-4 h-4 shrink-0" aria-hidden />
        <span>
          Accounting period <strong>{label}</strong>
          {!loading && ` · ${totals.drafts} draft${totals.drafts === 1 ? '' : 's'} across ${totals.entities} ${totals.entities === 1 ? 'entity' : 'entities'}`}
        </span>
        <button onClick={onClear} className={`ml-auto underline underline-offset-2 ${darkMode ? 'text-slate-300' : 'text-blue-800'}`}>
          Back to recent payrolls
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <p className={`text-xs ${subText}`}>Total debits</p>
          <p className="font-semibold tabular-nums">{fmtMoney(totals.debits)}</p>
        </div>
        <div>
          <p className={`text-xs ${subText}`}>Total credits</p>
          <p className="font-semibold tabular-nums">{fmtMoney(totals.credits)}</p>
        </div>
        <div>
          <p className={`text-xs ${subText}`}>Balance</p>
          <p className={`font-semibold tabular-nums ${balanced ? (darkMode ? 'text-emerald-300' : 'text-emerald-700') : (darkMode ? 'text-red-300' : 'text-red-700')}`}>
            {balanced ? 'Balanced' : fmtMoney(totals.variance)}
          </p>
        </div>
      </div>
    </div>
  );
}
