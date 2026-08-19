'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { isIeAccount } from '@/lib/payroll/inter-entity';
import QboImportGuide from '@/components/QboImportGuide';
import StatusBadge from '@/components/PayrollStatusBadge';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import { DirectionsBanner } from './DirectionsBanner';

/**
 * Local mirrors of the /api/payroll/eom* response shapes (Tasks 5-6: eom-store.ts EomRun,
 * qb-pool.ts PoolLine, revenue-rule.ts RevenueTest, store.ts PayrollHeader, qb-journal.ts
 * QbJournalEntryPayload/PostResult). Not imported directly — those modules pull in the RDS
 * pool (`pg`) / QuickBooks client, which must never land in a client bundle.
 */
// Named to match src/lib/payroll/revenue-rule.ts's EomEntity — this tab's scope is
// deliberately trio-only (Barbara's presence rule never covered FOCAS), distinct from the
// wider 4-member Entity the rest of payroll now uses.
type EomEntity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';
type HeaderStatus = 'draft' | 'needs_review' | 'approved' | 'posted' | 'error';
type PoolRule = 'revenue' | 'thirds' | 'fifty' | 'passthrough' | 'unknown';

interface PayrollHeader {
  id: number;
  entity: EomEntity;
  status: HeaderStatus;
  qb_doc_number: string | null;
  txn_date: string | null;
  total_debits: number;
  total_credits: number;
  variance: number;
  kind: string;
}

interface JournalLine {
  postingType: 'Debit' | 'Credit';
  amount: number;
  accountName: string;
  memo: string;
}

interface PoolLine {
  entity: EomEntity;
  txnType: string;
  txnId: string;
  txnDate: string;
  docNumber: string | null;
  accountName: string;
  className: string | null;
  departmentName: string | null;
  memo: string | null;
  amount: number;
  rule: PoolRule;
  counterparty: EomEntity | null;
}

interface RevenueTest {
  month: string;
  income: Record<EomEntity, number>;
}

interface RevenueSnapshot {
  test: RevenueTest;
  shares: Record<EomEntity, number> | null;
}

interface EomRun {
  month: string;
  pool: PoolLine[];
  revenue: RevenueSnapshot;
  attention: PoolLine[];
  generatedAt: string;
}

interface EomGetResponse {
  run: EomRun | null;
  headers: PayrollHeader[];
  lines: Record<string, JournalLine[]>;
}

interface EomGenerateResponse {
  headers: PayrollHeader[];
  warnings: string[];
}

interface ApproveResponse {
  ok: boolean;
  approvedIds: number[];
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
}

const ENTITIES: EomEntity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const SHORT_ENT: Record<EomEntity, string> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const RULE_LABEL: Record<PoolRule, string> = {
  revenue: 'Revenue %',
  thirds: '1/3 split',
  fifty: '50/50 split',
  passthrough: '100% reassignment',
  unknown: 'Unrecognized',
};
const STATUS_LABEL: Record<HeaderStatus, string> = {
  draft: 'Draft',
  needs_review: 'Needs review',
  approved: 'Approved',
  posted: 'Posted',
  error: 'Error',
};

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (n: number): string => usd.format(n);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Previous calendar month as 'YYYY-MM' — month-end allocation always closes the PRIOR
 *  month, never the one in progress, so that's the tab's default. */
function previousMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-11 for the CURRENT month -> already the 1-based number of the PREVIOUS month
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 12 : m;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** 'FL % Allo 2026.06' — client-side mirror of month-end.ts eomDocNumber, used only for
 *  not-yet-posted drafts (a posted card shows the real header.qb_doc_number instead). */
function draftDocNumber(entity: EomEntity, month: string): string {
  return `${SHORT_ENT[entity]} % Allo ${month.replace('-', '.')}`;
}

/**
 * End of Month tab: generates and reviews the month-end Allocate-pool JEs (revenue-share,
 * 1/3, and 50/50 splits across FL/TN/TX). Drafts here never touch QuickBooks until an
 * accountant explicitly approves and posts each one.
 */
export function EndOfMonthTab() {
  const { darkMode } = useDarkMode();
  const [month, setMonth] = useState<string>(previousMonth());
  const [data, setData] = useState<EomGetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busyHeaderId, setBusyHeaderId] = useState<number | null>(null);
  const [dryRunPayloads, setDryRunPayloads] = useState<Record<number, QbJournalEntryPayload>>({});
  // Draft sub-tab (mirrors the split-payroll review): one tab per location + Combined.
  const [draftTab, setDraftTab] = useState<EomEntity | 'combined'>('MedRock FL');
  // Stale-response guard for `load` (mirrors ReviewTab.loadDraft's requestSeqRef): bumped at the
  // start of every call. A slow response for a month the user has since switched away from would
  // otherwise land after a newer call's response and clobber the current month's data.
  const requestSeqRef = useRef(0);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inputBg = darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900';

  const load = useCallback(async (m: string) => {
    const token = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/payroll/eom?month=${encodeURIComponent(m)}`);
      const body = (await res.json()) as EomGetResponse & ApiErrorBody;
      if (token !== requestSeqRef.current) return; // superseded by a newer month switch/action
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
    } catch (e) {
      if (token !== requestSeqRef.current) return; // superseded — don't surface a stale error
      const message = e instanceof Error ? e.message : 'Failed to load month-end allocation';
      setError(message);
      setData(null);
    } finally {
      if (token === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDryRunPayloads({});
    setWarnings([]);
    void load(month);
  }, [month, load]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/payroll/eom/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      });
      const body = (await res.json()) as EomGenerateResponse & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setWarnings(body.warnings);
      await load(month);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to generate drafts';
      setError(message);
    } finally {
      setGenerating(false);
    }
  }, [month, load]);

  const handleApprove = useCallback(
    async (headerId: number) => {
      setBusyHeaderId(headerId);
      setError(null);
      try {
        const res = await fetch('/api/payroll/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headerId }),
        });
        const body = (await res.json()) as ApproveResponse & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        await load(month);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to approve draft';
        setError(message);
      } finally {
        setBusyHeaderId(null);
      }
    },
    [month, load],
  );

  const handleDryRun = useCallback(async (headerId: number) => {
    setBusyHeaderId(headerId);
    setError(null);
    try {
      const res = await fetch('/api/payroll/eom/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headerId, mode: 'dry_run' }),
      });
      const body = (await res.json()) as PostResult & ApiErrorBody;
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setDryRunPayloads((prev) => ({ ...prev, [headerId]: body.payload }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to build dry-run preview';
      setError(message);
    } finally {
      setBusyHeaderId(null);
    }
  }, []);

  const handlePostLive = useCallback(
    async (headerId: number, entity: EomEntity) => {
      const confirmed = window.confirm(
        `This will POST a LIVE journal entry to QuickBooks for ${entity}. This writes to the real general ledger and cannot be undone from here. Continue?`,
      );
      if (!confirmed) return;
      setBusyHeaderId(headerId);
      setError(null);
      try {
        const res = await fetch('/api/payroll/eom/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headerId, mode: 'live' }),
        });
        const body = (await res.json()) as PostResult & ApiErrorBody;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        await load(month);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to post journal entry';
        setError(message);
      } finally {
        setBusyHeaderId(null);
      }
    },
    [month, load],
  );

  const headers = data?.headers ?? [];
  const anyPosted = headers.some((h) => h.status === 'posted');
  const generateLabel = generating ? 'Generating…' : headers.length > 0 ? 'Regenerate drafts' : 'Generate drafts';

  // Clamp the sub-tab to a location that actually has a draft this month (an entity can be
  // absent when it has no legs, e.g. fifty-rule-only months).
  const availableEntities = headers.map((h) => h.entity);
  const activeDraft: EomEntity | 'combined' =
    draftTab === 'combined'
      ? 'combined'
      : availableEntities.includes(draftTab)
        ? draftTab
        : (availableEntities[0] ?? 'combined');
  const activeHeader = activeDraft === 'combined' ? null : (headers.find((h) => h.entity === activeDraft) ?? null);

  // Symmetry strip — recomputed client-side from the lines actually on screen, independent of
  // the server-trusted header.total_debits/credits, so a rendering bug would show up here too.
  // Inter-entity ("Due From/To") lines are excluded from the per-account shed/pickup check —
  // each IE pair deliberately uses a DIFFERENT account name on each side (see isIeAccount), so
  // they never net to zero on a single account name. Instead all IE lines across every draft
  // are netted into one signed total (cents, to avoid float drift) that must equal zero.
  const symmetry = useMemo(() => {
    const allLines = headers.flatMap((h) => data?.lines[String(h.id)] ?? []);
    const totalDebits = round2(allLines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const totalCredits = round2(allLines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    const byAccount = new Map<string, { debit: number; credit: number }>();
    let ieNetCents = 0;
    for (const l of allLines) {
      if (isIeAccount(l.accountName)) {
        const cents = Math.round(l.amount * 100);
        ieNetCents += l.postingType === 'Debit' ? cents : -cents;
        continue;
      }
      const g = byAccount.get(l.accountName) ?? { debit: 0, credit: 0 };
      if (l.postingType === 'Debit') g.debit = round2(g.debit + l.amount);
      else g.credit = round2(g.credit + l.amount);
      byAccount.set(l.accountName, g);
    }
    const imbalancedAccounts = [...byAccount.entries()]
      .filter(([, v]) => round2(v.debit - v.credit) !== 0)
      .map(([account, v]) => ({ account, diff: round2(v.debit - v.credit) }));
    const ieBalanced = ieNetCents === 0;
    return {
      totalDebits,
      totalCredits,
      ieNet: ieNetCents / 100,
      ieBalanced,
      balanced: totalDebits === totalCredits && imbalancedAccounts.length === 0 && ieBalanced,
      imbalancedAccounts,
    };
  }, [headers, data]);

  return (
    <div className="space-y-6">
      <DirectionsBanner darkMode={darkMode} title="How month-end allocation works">
        <p>
          Pulls Allocate-flagged costs from QuickBooks for the month, splits them by Barbara&apos;s rules, and
          drafts the month-end JEs. Drafts post nothing until approved and posted here.
        </p>
      </DirectionsBanner>

      <div className={`rounded-xl shadow-sm p-4 ${cardBg} flex flex-wrap items-center gap-3 border ${border}`}>
        <label className={`text-sm ${subText}`}>
          Month
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={`block mt-1 rounded-md border px-2 py-1.5 text-sm ${inputBg}`}
          />
        </label>
        <button
          onClick={() => void handleGenerate()}
          disabled={generating || anyPosted}
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

      {loading && !data ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" aria-hidden />
          Loading month-end allocation…
        </div>
      ) : !data || (!data.run && headers.length === 0) ? (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          No allocation run for {month} yet. Click <strong>Generate drafts</strong> above to pull QuickBooks and
          build them.
        </div>
      ) : (
        <>
          {data.run ? (
            <>
              <RevenueCard darkMode={darkMode} cardBg={cardBg} subText={subText} border={border} snapshot={data.run.revenue} />

              <PoolCard darkMode={darkMode} cardBg={cardBg} subText={subText} border={border} pool={data.run.pool} />

              {data.run.attention.length > 0 && (
                <AttentionCard
                  darkMode={darkMode}
                  cardBg={cardBg}
                  subText={subText}
                  border={border}
                  lines={data.run.attention}
                  month={month}
                />
              )}
            </>
          ) : (
            <div
              className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
                darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
              }`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <p>Snapshot missing for this generation — Regenerate to rebuild the pool view.</p>
            </div>
          )}

          {headers.length === 0 ? (
            <div className={`rounded-xl shadow-sm p-6 ${cardBg} text-center text-sm ${subText}`}>
              No drafts generated for {month} yet.
            </div>
          ) : (
            <>
              {/* Sub-tab bar — one tab per location draft + Combined (mirrors the split-payroll review). */}
              <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
                {headers.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => setDraftTab(h.entity)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
                      activeDraft === h.entity
                        ? 'bg-blue-600 text-white'
                        : darkMode
                          ? 'text-slate-300 hover:bg-slate-700'
                          : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {SHORT_ENT[h.entity]} · {STATUS_LABEL[h.status]}
                  </button>
                ))}
                <button
                  onClick={() => setDraftTab('combined')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
                    activeDraft === 'combined'
                      ? 'bg-blue-600 text-white'
                      : darkMode
                        ? 'text-slate-300 hover:bg-slate-700'
                        : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Combined
                </button>
              </div>

              {activeHeader ? (
                <DraftCard
                  key={activeHeader.id}
                  darkMode={darkMode}
                  cardBg={cardBg}
                  subText={subText}
                  border={border}
                  header={activeHeader}
                  month={month}
                  lines={data.lines[String(activeHeader.id)] ?? []}
                  busy={busyHeaderId === activeHeader.id}
                  dryRunPayload={dryRunPayloads[activeHeader.id] ?? null}
                  onApprove={() => void handleApprove(activeHeader.id)}
                  onDryRun={() => void handleDryRun(activeHeader.id)}
                  onPostLive={() => void handlePostLive(activeHeader.id, activeHeader.entity)}
                />
              ) : (
                <CombinedDraftsCard
                  cardBg={cardBg}
                  subText={subText}
                  border={border}
                  headers={headers}
                  linesById={data.lines}
                  month={month}
                />
              )}
            </>
          )}

          {headers.length > 0 && <SymmetryStrip darkMode={darkMode} cardBg={cardBg} border={border} symmetry={symmetry} />}
        </>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function RevenueCard({
  darkMode,
  cardBg,
  subText,
  border,
  snapshot,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  snapshot: RevenueSnapshot;
}) {
  const { test, shares } = snapshot;
  const withRevenue = ENTITIES.filter((e) => test.income[e] > 0);
  const headline =
    withRevenue.length === 0
      ? 'No location has revenue this month — allocation cannot run.'
      : withRevenue.length === ENTITIES.length
        ? `All ${ENTITIES.length} locations have revenue → 1/${ENTITIES.length} each`
        : withRevenue.length === 1
          ? '1 location has revenue → 100%'
          : `${withRevenue.length} locations have revenue → 1/${withRevenue.length} each`;

  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg} border ${border} space-y-3`}>
      <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Revenue test — {test.month}</p>
      <p className="text-sm font-medium">{headline}</p>
      {shares === null && (
        <p className={`text-sm flex items-center gap-2 ${darkMode ? 'text-red-300' : 'text-red-700'}`}>
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          No location has revenue — the stored run has no share weights. Allocation could not run.
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        {ENTITIES.map((e) => (
          <div key={e} className={`rounded-lg border p-3 ${border}`}>
            <p className="text-sm font-semibold">{SHORT_ENT[e]}</p>
            <p className={`text-xs ${subText}`}>{fmtMoney(test.income[e])} income</p>
            <p className="text-lg font-bold tabular-nums">{shares ? `${shares[e].toFixed(2)}%` : '—'}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PoolBucket {
  entity: EomEntity;
  rule: PoolRule;
  accountName: string;
  net: number;
  lines: PoolLine[];
}

function groupPool(pool: PoolLine[]): PoolBucket[] {
  const map = new Map<string, PoolBucket>();
  for (const l of pool) {
    const key = `${l.entity}¦${l.rule}¦${l.accountName}`;
    const g = map.get(key) ?? { entity: l.entity, rule: l.rule, accountName: l.accountName, net: 0, lines: [] };
    g.net = round2(g.net + l.amount);
    g.lines.push(l);
    map.set(key, g);
  }
  return [...map.values()].sort(
    (a, b) => a.entity.localeCompare(b.entity) || a.rule.localeCompare(b.rule) || a.accountName.localeCompare(b.accountName),
  );
}

function PoolCard({
  darkMode,
  cardBg,
  subText,
  border,
  pool,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  pool: PoolLine[];
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const buckets = useMemo(() => groupPool(pool), [pool]);
  const byEntity = useMemo(() => {
    const map = new Map<EomEntity, PoolBucket[]>();
    for (const b of buckets) {
      const list = map.get(b.entity) ?? [];
      list.push(b);
      map.set(b.entity, list);
    }
    return map;
  }, [buckets]);
  const ruleTotals = useMemo(() => {
    const totals = new Map<PoolRule, number>();
    for (const b of buckets) totals.set(b.rule, round2((totals.get(b.rule) ?? 0) + b.net));
    return totals;
  }, [buckets]);

  const toggle = (key: string): void =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-4`}>
      <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>
        Allocation pool — {pool.length} source line{pool.length === 1 ? '' : 's'}
      </p>

      {[...byEntity.entries()].map(([entity, entBuckets]) => (
        <div key={entity} className="space-y-1">
          <p className="text-sm font-semibold">{entity}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${border}`}>
                  <th className={th}>Rule</th>
                  <th className={th}>Account</th>
                  <th className={`${th} text-right`}>Net</th>
                  <th className={th}># lines</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {entBuckets.map((b) => {
                  const key = `${b.entity}¦${b.rule}¦${b.accountName}`;
                  const open = openKeys.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className={`border-b ${border}`}>
                        <td className="px-2 py-1">{RULE_LABEL[b.rule]}</td>
                        <td className="px-2 py-1">{b.accountName}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(b.net)}</td>
                        <td className={`px-2 py-1 text-xs ${subText}`}>{b.lines.length}</td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => toggle(key)}
                            className={`text-xs flex items-center gap-1 ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
                          >
                            {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
                            Detail
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className={`border-b ${border}`}>
                          <td colSpan={5} className="px-2 py-2">
                            <table className="w-full text-xs">
                              <thead>
                                <tr>
                                  <th className={th}>Date</th>
                                  <th className={th}>Type</th>
                                  <th className={th}>Doc</th>
                                  <th className={th}>Memo</th>
                                  <th className={`${th} text-right`}>Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {b.lines.map((l, i) => (
                                  <tr key={`${l.txnId}-${i}`}>
                                    <td className="px-2 py-1">{l.txnDate}</td>
                                    <td className="px-2 py-1">{l.txnType}</td>
                                    <td className={`px-2 py-1 ${subText}`}>{l.docNumber ?? '—'}</td>
                                    <td className={`px-2 py-1 ${subText}`}>{l.memo ?? ''}</td>
                                    <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(l.amount)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className={`pt-2 border-t ${border} text-sm space-y-1`}>
        {[...ruleTotals.entries()].map(([rule, total]) => (
          <div key={rule} className="flex justify-between">
            <span className={subText}>{RULE_LABEL[rule]} total</span>
            <span className="font-semibold tabular-nums">{fmtMoney(total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Why a pool line was held back from the drafts. One code per branch in qb-pool.ts that can
 * emit a non-splittable rule — `fetchAllocationPool` is the only producer of these lines, so
 * these codes must stay in step with `classifyAllocateFlag` / `poolLinesFromExpenseTxn`.
 * 'other' is a defensive catch-all: no current branch reaches it, but a new class shape in
 * qb-pool must never render a blank Reason cell.
 */
type AttentionCode = 'passthrough' | 'self_class' | 'item_line' | 'unrecognized_class' | 'other';

/** qb-pool.ts's placeholder account for an Allocate-flagged line with no AccountRef. */
const ITEM_BASED_ACCOUNT = '(item-based line)';
const SHORT_TO_ENTITY: Record<string, EomEntity> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
// Same two literals qb-pool.classifyAllocateFlag matches on — reproduced (not loosened into one
// combined pattern) so a near-miss class like 'Allocate - FL50' is reported as unrecognized here
// exactly as qb-pool treats it, rather than being mislabelled a self-referential class.
const FIFTY_CLASS_RE = /^Allocate - Split (FL|TN|TX)50$/;
const FULL_CLASS_RE = /^Allocate - (FL|TN|TX)$/;

const CODE_TITLE: Record<AttentionCode, string> = {
  passthrough: 'Bill/card purchase — QuickBooks Intercompany books the move; confirm it did',
  self_class: 'Class names the line’s own company',
  item_line: 'Line has no expense account',
  unrecognized_class: 'Class is not a split rule we know',
  other: 'Could not be matched to a split rule',
};

/** What Barbara does about each code. Shown once per code in the legend rather than repeated
 *  on all 80 rows. Passthrough wording is scoped to Bill/Purchase/VendorCredit — the only
 *  txnTypes that still land here after 2026-08-19 (qb-pool.isPooledLine pools passthrough from
 *  Deposits/JEs/drafts, where nothing else moves the money; QBO's Intercompany auto-booking was
 *  verified live for bills/card purchases and proven ABSENT for deposits). */
const CODE_ACTION: Record<AttentionCode, string> = {
  passthrough:
    'Only Bills and card Purchases appear here. For those, QuickBooks’ Intercompany allocation books the move on the transaction itself — a system journal entry credits the expense and debits Due From/To within minutes of entry (verified 2026-08-19 against live pairs in both books). Month-end skips them so the cost is never moved twice — but the automation is QuickBooks’, not ours, so spot-check that the matching system JE exists (it has no journal number). Allocate-classed deposits, journal entries, and payroll drafts do NOT show here: nothing in QuickBooks moves those, so month-end builds their legs into the allocation JE directly.',
  self_class:
    'Fix the class in QuickBooks, then Regenerate. The class names the same company the transaction is already sitting in, so there is no other company to move the cost to — usually the wrong state was picked off the class list.',
  item_line:
    'Recode the line in QuickBooks, then Regenerate. It is coded to a product/service item instead of an expense account, so there is no account name to credit at the source company and debit at the receiving one. Point it at an expense account, or clear the Allocate flag if it should not be shared.',
  unrecognized_class:
    'Fix the class in QuickBooks, then Regenerate. Month-end only splits "Allocate - %" (revenue share), "Allocate - SplitX3" (1/3 each), "Allocate - Split FL50 / TN50 / TX50" (50/50), and "Allocate - FL / TN / TX" (100% to that company). Anything else is normally a typo or a newly created class — if it is a rule we should support, send it over.',
  other:
    'Open the transaction in QuickBooks and check the Class and Department on this line — neither one matched a split rule.',
};

/** Per-line headline: names the specific company or class involved, so a row still explains
 *  itself when read on its own (the legend above carries the shared "what to do"). */
function attentionReason(l: PoolLine): { code: AttentionCode; label: string } {
  // Checked first: qb-pool stamps 'unknown' on an account-less line whatever its class said,
  // so the missing account is the blocking problem even when the class also looks wrong.
  if (l.accountName === ITEM_BASED_ACCOUNT) {
    return { code: 'item_line', label: 'Coded to an item, not an expense account — nothing to split' };
  }
  if (l.rule === 'passthrough') {
    const target = l.counterparty ? SHORT_ENT[l.counterparty] : 'another company';
    return { code: 'passthrough', label: `100% assigned to ${target} — QuickBooks Intercompany books this one; confirm its system JE` };
  }
  const cls = l.className;
  if (cls) {
    const named = FIFTY_CLASS_RE.exec(cls) ?? FULL_CLASS_RE.exec(cls);
    if (named && SHORT_TO_ENTITY[named[1]] === l.entity) {
      return { code: 'self_class', label: `Class "${cls}" points at ${SHORT_ENT[l.entity]}, the company it is already in` };
    }
    if (cls.startsWith('Allocate')) {
      return { code: 'unrecognized_class', label: `Class "${cls}" matches no split rule` };
    }
  }
  return { code: 'other', label: 'Allocate-flagged, but no split rule matched' };
}

/**
 * QBO web deep links for the four transaction types fetchAllocationPool queries. Same URL
 * shape as src/lib/qb-links.ts qbDeepLink, copied rather than imported because that module
 * also owns the RDS matching queries and must never reach a client bundle — the same reason
 * QbLinksReview.tsx keeps its own copy.
 */
const QBO_TXN_PATH: Record<string, string> = {
  JournalEntry: 'journal',
  Purchase: 'expense',
  Bill: 'bill',
  VendorCredit: 'vendorcredit',
};

function qbTxnLink(txnType: string, txnId: string): string | null {
  const path = QBO_TXN_PATH[txnType];
  return path ? `https://app.qbo.intuit.com/app/${path}?txnId=${encodeURIComponent(txnId)}` : null;
}

function AttentionCard({
  darkMode,
  cardBg,
  subText,
  border,
  lines,
  month,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  lines: PoolLine[];
  month: string;
}) {
  const rows = useMemo(() => lines.map((l) => ({ line: l, reason: attentionReason(l) })), [lines]);

  /**
   * The card used to headline the COMBINED count — "Needs attention — 86 lines" — and Carson's
   * reaction (2026-08-10) was "this part makes no sense". It didn't: on a real month, 89 of 89
   * held-back lines were `passthrough`, which need no action whatsoever. The card was announcing
   * 89 problems where there were zero.
   *
   * `passthrough` here is not a problem: since 2026-08-19 only Bill/Purchase/VendorCredit
   * passthrough reaches this card (qb-pool.isPooledLine), and for those QuickBooks' own
   * Intercompany allocation books the move on the transaction (verified against live JE
   * pairs). Month-end skips them precisely so the cost is never moved twice. So they are
   * split out, counted separately, and collapsed — while anything that genuinely needs a
   * person is what the heading now counts.
   */
  const toFix = useMemo(() => rows.filter((r) => r.reason.code !== 'passthrough'), [rows]);
  const noAction = useMemo(() => rows.filter((r) => r.reason.code === 'passthrough'), [rows]);
  const noActionTotal = useMemo(() => round2(noAction.reduce((s, r) => s + r.line.amount, 0)), [noAction]);

  const legend = useMemo(() => {
    const map = new Map<AttentionCode, { code: AttentionCode; count: number; total: number }>();
    for (const { line, reason } of toFix) {
      const g = map.get(reason.code) ?? { code: reason.code, count: 0, total: 0 };
      g.count += 1;
      g.total = round2(g.total + line.amount);
      map.set(reason.code, g);
    }
    return [...map.values()];
  }, [toFix]);

  const [showNoAction, setShowNoAction] = useState(false);

  const clean = toFix.length === 0;
  const amber = darkMode ? 'text-amber-200' : 'text-amber-800';
  const cardBorder = clean ? border : darkMode ? 'border-amber-800' : 'border-amber-300';

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${cardBorder} p-4 space-y-3`}>
      <p className={`text-xs font-semibold uppercase tracking-wider ${clean ? subText : amber}`}>
        {clean
          ? 'Held back from the drafts — nothing to fix'
          : `Needs a fix in QuickBooks — ${toFix.length} line${toFix.length === 1 ? '' : 's'}`}
      </p>

      <p className={`text-xs leading-relaxed ${subText}`}>
        <span className="font-semibold">What this is:</span> generating drafts pulls every Journal Entry, Expense,
        Bill, Vendor Credit and Deposit dated in {month} from all three QuickBooks companies and keeps the lines
        carrying an <code>Allocate&nbsp;-&nbsp;…</code> class or the <code>% Allocation</code> department. Lines
        whose class matches a split rule — including 100%-reassignment classes on deposits, journal entries and
        payroll drafts — go into the allocation pool above. Held back here are only the lines month-end must NOT
        move: bills and card purchases that QuickBooks&apos; Intercompany automation books itself, plus anything
        broken enough to need a person.
      </p>

      {clean ? (
        <p className={`text-xs ${darkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>
          Every line held back this month is a bill or card purchase that QuickBooks&apos; Intercompany automation
          books on the transaction itself — month-end skips them so the money never moves twice. Nothing needs
          re-entry; worth a periodic spot-check that the matching system entries exist (open a transaction below and
          look for its paired journal entry, dated the same day with no journal number).
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {legend.map((g) => (
              <div key={g.code} className={`rounded-lg border p-2.5 ${border}`}>
                <p className="text-sm font-semibold">
                  {CODE_TITLE[g.code]}{' '}
                  <span className={`font-normal text-xs ${subText}`}>
                    · {g.count} line{g.count === 1 ? '' : 's'} · {fmtMoney(g.total)}
                  </span>
                </p>
                <p className={`text-xs leading-relaxed mt-0.5 ${subText}`}>{CODE_ACTION[g.code]}</p>
              </div>
            ))}
          </div>

          <AttentionTable
            darkMode={darkMode}
            subText={subText}
            border={border}
            rows={toFix}
          />
        </>
      )}

      {noAction.length > 0 && (
        <div className={`rounded-lg border ${border}`}>
          <button
            onClick={() => setShowNoAction((v) => !v)}
            aria-expanded={showNoAction}
            className="flex w-full items-center gap-2 p-2.5 text-left"
          >
            {showNoAction ? <ChevronDown className="w-4 h-4 shrink-0" aria-hidden /> : <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />}
            <span className="text-sm font-semibold">
              {CODE_TITLE.passthrough}{' '}
              <span className={`font-normal text-xs ${subText}`}>
                · {noAction.length} line{noAction.length === 1 ? '' : 's'} · {fmtMoney(noActionTotal)}
              </span>
            </span>
          </button>
          {showNoAction && (
            <div className="px-2.5 pb-2.5 space-y-2">
              <p className={`text-xs leading-relaxed ${subText}`}>{CODE_ACTION.passthrough}</p>
              <AttentionTable darkMode={darkMode} subText={subText} border={border} rows={noAction} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The held-back lines themselves. Shared by both sections so they read identically. */
function AttentionTable({
  darkMode,
  subText,
  border,
  rows,
}: {
  darkMode: boolean;
  subText: string;
  border: string;
  rows: Array<{ line: PoolLine; reason: { code: AttentionCode; label: string } }>;
}) {
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const amber = darkMode ? 'text-amber-200' : 'text-amber-800';
  const linkText = darkMode ? 'text-blue-300' : 'text-blue-600';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={`border-b ${border}`}>
            <th className={th}>Entity</th>
            <th className={th}>Reason</th>
            <th className={th}>Record</th>
            <th className={th}>Account</th>
            <th className={th}>Date</th>
            <th className={th}>Memo</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ line: l, reason }, i) => {
            const href = qbTxnLink(l.txnType, l.txnId);
            // Doc # is what Barbara searches on in QuickBooks, but JEs from some feeds carry
            // none — fall back to the txn id, which is both the URL key and searchable.
            const recordLabel = l.docNumber ?? `#${l.txnId}`;
            return (
              <tr key={`${l.txnId}-${i}`} className={`border-b last:border-0 ${border} align-top`}>
                <td className="px-2 py-1 whitespace-nowrap">{l.entity}</td>
                <td className={`px-2 py-1 text-xs ${reason.code === 'passthrough' ? subText : amber}`}>{reason.label}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className={`text-xs font-medium ${linkText} hover:underline`}>
                      {recordLabel}
                    </a>
                  ) : (
                    <span className="text-xs font-medium">{recordLabel}</span>
                  )}
                  <span className={`block text-[11px] ${subText}`}>
                    {l.txnType} · id {l.txnId}
                  </span>
                </td>
                <td className="px-2 py-1">{l.accountName}</td>
                <td className={`px-2 py-1 text-xs whitespace-nowrap ${subText}`}>{l.txnDate}</td>
                <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo ?? ''}</td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{fmtMoney(l.amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


function DryRunPreview({ darkMode, payload }: { darkMode: boolean; payload: QbJournalEntryPayload }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="space-y-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-xs flex items-center gap-1 font-medium ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
        Dry-run payload — {payload.DocNumber}
      </button>
      {open && (
        <pre
          className={`text-[11px] font-mono rounded-lg border p-3 overflow-x-auto max-h-72 overflow-y-auto ${
            darkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
          }`}
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Read-only merged view of all three drafts (mirrors the split-payroll Combined grid):
 *  every line with its entity, one totals row. Approve/post live on the per-location tabs. */
function CombinedDraftsCard({
  cardBg,
  subText,
  border,
  headers,
  linesById,
  month,
}: {
  cardBg: string;
  subText: string;
  border: string;
  headers: PayrollHeader[];
  linesById: Record<string, JournalLine[]>;
  month: string;
}) {
  const rows = headers.flatMap((h) =>
    (linesById[String(h.id)] ?? []).map((l, i) => ({ ...l, entity: h.entity, _key: `${h.id}-${i}` })),
  );
  const debitTotal = round2(rows.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const creditTotal = round2(rows.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`px-4 py-3 border-b ${border} flex items-center justify-between`}>
        <p className="text-sm font-semibold">Combined — all locations, {month}</p>
        <p className={`text-xs ${subText}`}>read-only · approve and post on each location&apos;s tab</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`text-left text-xs uppercase tracking-wide ${subText}`}>
              <th className="px-2 py-2">Entity</th>
              <th className="px-2 py-2">Posting</th>
              <th className="px-2 py-2">Account</th>
              <th className="px-2 py-2">Memo</th>
              <th className="px-2 py-2 text-right">Debit</th>
              <th className="px-2 py-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l._key} className={`border-t ${border}`}>
                <td className={`px-2 py-1 text-xs whitespace-nowrap ${subText}`}>{SHORT_ENT[l.entity]}</td>
                <td className={`px-2 py-1 text-xs ${subText}`}>{l.postingType}</td>
                <td className="px-2 py-1">{l.accountName}</td>
                <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                <td className="px-2 py-1 text-right tabular-nums">{l.postingType === 'Debit' ? fmtMoney(l.amount) : ''}</td>
                <td className="px-2 py-1 text-right tabular-nums">{l.postingType === 'Credit' ? fmtMoney(l.amount) : ''}</td>
              </tr>
            ))}
            <tr className={`border-t font-semibold ${border}`}>
              <td className="px-2 py-2" colSpan={4}>
                Totals
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(debitTotal)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(creditTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DraftCard({
  darkMode,
  cardBg,
  subText,
  border,
  header,
  month,
  lines,
  busy,
  dryRunPayload,
  onApprove,
  onDryRun,
  onPostLive,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  header: PayrollHeader;
  month: string;
  lines: JournalLine[];
  busy: boolean;
  dryRunPayload: QbJournalEntryPayload | null;
  onApprove: () => void;
  onDryRun: () => void;
  onPostLive: () => void;
}) {
  const posted = header.status === 'posted';
  const [qboGuideOpen, setQboGuideOpen] = useState(false);
  const docNumber = posted ? (header.qb_doc_number ?? '—') : draftDocNumber(header.entity, month);
  const debitTotal = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const creditTotal = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{header.entity}</p>
          <p className={`text-xs ${subText}`}>
            {docNumber} · {header.txn_date ?? '—'}
          </p>
        </div>
        <StatusBadge darkMode={darkMode} status={header.status} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${border}`}>
              <th className={th}>Posting</th>
              <th className={th}>Account</th>
              <th className={th}>Memo</th>
              <th className={`${th} text-right`}>Debit</th>
              <th className={`${th} text-right`}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={`border-b last:border-0 ${border}`}>
                <td className={`px-2 py-1 text-xs ${subText}`}>{l.postingType}</td>
                <td className="px-2 py-1">{l.accountName}</td>
                <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                <td className="px-2 py-1 text-right tabular-nums">{l.postingType === 'Debit' ? fmtMoney(l.amount) : ''}</td>
                <td className="px-2 py-1 text-right tabular-nums">{l.postingType === 'Credit' ? fmtMoney(l.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={`border-t font-semibold ${border}`}>
              <td className="px-2 py-1" colSpan={3}>
                Total
              </td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(debitTotal)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(creditTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {!posted && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setQboGuideOpen(true)}
            title={
              `Download ${docNumber} as a CSV formatted for QuickBooks journal-entry import ` +
              `(Settings → Import data → Journal entries). One file per company — import this one into ${header.entity}. ` +
              'Account names come pre-numbered to match the chart of accounts. Opens an import checklist first.'
            }
            className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border ${
              darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Download className="w-4 h-4" aria-hidden />
            QBO Import CSV
          </button>
          <QboImportGuide
            open={qboGuideOpen}
            onClose={() => setQboGuideOpen(false)}
            darkMode={darkMode}
            entity={header.entity}
            href={`/api/payroll/export?headerId=${header.id}&format=qbo`}
          />
          <button
            onClick={onApprove}
            disabled={busy || header.status === 'approved'}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
              darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldCheck className="w-4 h-4" aria-hidden />}
            {header.status === 'approved' ? 'Approved' : 'Approve'}
          </button>
          <button
            onClick={onDryRun}
            disabled={busy}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
              darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
            Dry run
          </button>
          <button
            onClick={onPostLive}
            disabled={busy || header.status !== 'approved'}
            title={header.status !== 'approved' ? 'Approve this draft before posting' : 'Post the live journal entry to QuickBooks'}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-bold rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Zap className="w-4 h-4" aria-hidden />}
            Post to QuickBooks
          </button>
        </div>
      )}

      {dryRunPayload && <DryRunPreview darkMode={darkMode} payload={dryRunPayload} />}
    </div>
  );
}

function SymmetryStrip({
  darkMode,
  cardBg,
  border,
  symmetry,
}: {
  darkMode: boolean;
  cardBg: string;
  border: string;
  symmetry: {
    totalDebits: number;
    totalCredits: number;
    ieNet: number;
    ieBalanced: boolean;
    balanced: boolean;
    imbalancedAccounts: Array<{ account: string; diff: number }>;
  };
}) {
  // Totals can match while a per-account or inter-entity check still fails (or vice versa isn't
  // possible, since a per-account/IE mismatch always shows up in the totals too — but keep the
  // headline honest either way rather than assuming "not balanced" always means unequal totals).
  const totalsMatch = symmetry.totalDebits === symmetry.totalCredits;
  const redText = darkMode ? 'text-red-300' : 'text-red-700';
  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${symmetry.balanced ? border : darkMode ? 'border-red-800' : 'border-red-300'} p-4 space-y-2`}>
      <div className="flex items-center gap-2 text-sm">
        {symmetry.balanced ? (
          <>
            <CheckCircle2 className={`w-4 h-4 ${darkMode ? 'text-emerald-300' : 'text-emerald-600'}`} aria-hidden />
            <span className={darkMode ? 'text-emerald-300' : 'text-emerald-700'}>
              All drafts balance — {fmtMoney(symmetry.totalDebits)} debits = {fmtMoney(symmetry.totalCredits)} credits, every
              non-IE account&apos;s shed = pickup, and inter-entity lines net to $0.00.
            </span>
          </>
        ) : !totalsMatch ? (
          <>
            <XCircle className={`w-4 h-4 ${darkMode ? 'text-red-300' : 'text-red-600'}`} aria-hidden />
            <span className={redText}>
              Drafts do not balance: {fmtMoney(symmetry.totalDebits)} debits vs {fmtMoney(symmetry.totalCredits)} credits.
            </span>
          </>
        ) : (
          <>
            <XCircle className={`w-4 h-4 ${darkMode ? 'text-red-300' : 'text-red-600'}`} aria-hidden />
            <span className={redText}>
              Totals match ({fmtMoney(symmetry.totalDebits)} debits = {fmtMoney(symmetry.totalCredits)} credits), but individual
              checks below failed.
            </span>
          </>
        )}
      </div>
      {symmetry.imbalancedAccounts.length > 0 && (
        <ul className={`text-xs space-y-0.5 ${redText}`}>
          {symmetry.imbalancedAccounts.map((a) => (
            <li key={a.account}>
              {a.account}: shed/pickup mismatch of {fmtMoney(a.diff)}
            </li>
          ))}
        </ul>
      )}
      {!symmetry.ieBalanced && (
        <p className={`text-xs ${redText}`}>
          Inter-entity (Due From/To) lines do not net to zero across drafts: {fmtMoney(symmetry.ieNet)} (should be $0.00).
        </p>
      )}
    </div>
  );
}
