'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  FlaskConical,
  Info,
  Link2,
  RefreshCw,
} from 'lucide-react';
import type {
  ApBillRow,
  ApWeeklyReport,
  AutoAchBatch,
  DuplicateGroup,
  RampOrphan,
} from '@/lib/ap-weekly';

export const dynamic = 'force-dynamic';

const LOCATIONS = ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const;

/** The dormant Weekly AP Aging procedure doc (bookkeeper journal, Amy's rules) this page automates. */
const SOURCE_PROCEDURE_URL = 'https://docs.google.com/document/d/1rOcQUvcBADmZRMbb4alA3o5llkR8TeFA/edit';
type LocationTab = (typeof LOCATIONS)[number];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtMoney(n: number | null): string {
  return n === null ? '—' : usd.format(n);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface FetchState {
  report: ApWeeklyReport | null;
  loading: boolean;
  error: string | null;
}

export default function ApWeeklyPage() {
  const { darkMode } = useDarkMode();
  const [tab, setTab] = useState<LocationTab>('MedRock FL');
  const [reportDate, setReportDate] = useState<string>(todayIso());
  const [states, setStates] = useState<Record<string, FetchState>>({});

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const headText = darkMode ? 'text-white' : 'text-slate-900';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';
  const theadBg = darkMode ? 'bg-slate-700/50' : 'bg-slate-100';
  const rowBorder = darkMode ? 'border-slate-700/60' : 'border-slate-100';

  const key = `${tab}|${reportDate}`;
  const current: FetchState = states[key] ?? { report: null, loading: false, error: null };

  const load = useCallback(
    async (force: boolean) => {
      const k = `${tab}|${reportDate}`;
      setStates((prev) => {
        const existing = prev[k];
        if (!force && (existing?.report || existing?.loading)) return prev;
        return { ...prev, [k]: { report: force ? null : (existing?.report ?? null), loading: true, error: null } };
      });
      try {
        const res = await fetch(
          `/api/ap-weekly?location=${encodeURIComponent(tab)}&reportDate=${reportDate}`,
          { cache: 'no-store' },
        );
        const body = (await res.json()) as ApWeeklyReport & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setStates((prev) => ({ ...prev, [k]: { report: body, loading: false, error: null } }));
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load report';
        setStates((prev) => ({ ...prev, [k]: { report: null, loading: false, error: message } }));
      }
    },
    [tab, reportDate],
  );

  useEffect(() => {
    if (!current.report && !current.loading && !current.error) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const report = current.report;
  const shared = { darkMode, cardBg, subText, border, theadBg, rowBorder };

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Accounts Payable</p>
          <h1 className={`text-2xl font-bold ${headText}`}>Weekly AP Report</h1>
        </div>

        {/* What this is — always visible */}
        <div
          className={`rounded-xl border p-4 flex gap-3 ${
            darkMode ? 'bg-amber-950/40 border-amber-800 text-amber-100' : 'bg-amber-50 border-amber-300 text-amber-900'
          }`}
        >
          <FlaskConical className="w-5 h-5 shrink-0 mt-0.5" aria-hidden />
          <div className="text-sm space-y-1">
            <p className="font-semibold">
              What this is: an automated, report-only revival of the dormant Weekly AP procedure (suspended Jan/Feb 2026).
            </p>
            <p>
              Every section below is <strong>read-only</strong> — it pulls live open AP from QuickBooks and Bill Pay data
              from Ramp, applies the bookkeeper rules (duplicate check, the report-date + 7 days auto-ACH rule, the Ramp
              cross-check formerly done by XLOOKUP), and <strong>proposes</strong> actions. Nothing is posted to
              QuickBooks and nothing is marked paid in Ramp. Payment-posting rules and the auto-ACH vendor list still
              need controller (Amy) sign-off before any write automation. Running locally — not deployed.
            </p>
            <p>
              <a
                href={SOURCE_PROCEDURE_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline underline-offset-2 hover:opacity-80"
              >
                Source procedure: “Weekly AP Aging Procedure” — the bookkeeper working journal with Amy&apos;s rules
                (Google Doc) ↗
              </a>
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className={`rounded-xl shadow-sm p-4 ${cardBg} flex flex-wrap items-center gap-3`}>
          <div className="flex rounded-lg overflow-hidden border ${border}">
            {LOCATIONS.map((loc) => (
              <button
                key={loc}
                onClick={() => setTab(loc)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  tab === loc
                    ? 'bg-blue-600 text-white'
                    : darkMode
                      ? 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {loc.replace('MedRock ', '')}
              </button>
            ))}
          </div>
          <label className={`text-sm ${subText}`}>
            Report date{' '}
            <input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              className={`ml-1 rounded-md border px-2 py-1.5 text-sm ${
                darkMode ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-300 text-slate-900'
              }`}
            />
          </label>
          {report && (
            <span className={`text-sm ${subText}`}>
              Auto-ACH window: due on or before <strong>{report.dueCutoff}</strong> (report date + 7 days)
            </span>
          )}
          <button
            onClick={() => void load(true)}
            disabled={current.loading}
            className="ml-auto flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${current.loading ? 'animate-spin' : ''}`} aria-hidden />
            {current.loading ? 'Pulling…' : 'Refresh'}
          </button>
        </div>

        {current.loading && !report && (
          <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
            Pulling open AP from QuickBooks and bills from Ramp for {tab}…
          </div>
        )}

        {current.error && (
          <ErrorStrip darkMode={darkMode} label={`Report failed for ${tab}`} message={current.error} />
        )}

        {report && (
          <>
            {report.errors.map((err, i) => (
              <ErrorStrip
                key={i}
                darkMode={darkMode}
                label={err.source === 'quickbooks' ? 'QuickBooks (partial data)' : 'Ramp (partial data)'}
                message={err.message}
              />
            ))}

            {/* Summary tiles */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Tile {...shared} label="Open AP total" value={fmtMoney(report.totals.openApTotal)} />
              <Tile {...shared} label="Open bills" value={String(report.totals.billCount)} />
              <Tile
                {...shared}
                label={`Due ≤ ${report.dueCutoff}`}
                value={fmtMoney(report.totals.dueInWindowTotal)}
                sub={`${report.totals.dueInWindowCount} bills`}
              />
              <Tile
                {...shared}
                label="Proposed auto-ACH"
                value={fmtMoney(report.totals.proposedAutoAchTotal)}
                sub={`${report.totals.proposedAutoAchCount} bills — NOT posted`}
              />
              <Tile {...shared} label="Duplicate groups" value={String(report.totals.duplicateGroupCount)} />
              <Tile
                {...shared}
                label="Mark paid in Ramp"
                value={String(report.totals.markPaidInRampCandidates)}
                sub="candidates (confirmed paid in QBO)"
              />
            </div>

            <AutoAchSection {...shared} batches={report.autoAchBatches} cutoff={report.dueCutoff} />
            <DuplicatesSection {...shared} duplicates={report.duplicates} />
            <RampOrphansSection {...shared} orphans={report.rampOrphans} />
            <OpenApSection {...shared} bills={report.bills} />

            {report.vendorCredits.length > 0 && (
              <Section
                {...shared}
                title={`Open vendor credits (${report.vendorCredits.length})`}
                subtitle="Unapplied credits that reduce what is actually owed — informational."
              >
                <SimpleTable
                  {...shared}
                  headers={['Vendor', 'Credit #', 'Date', 'Unapplied', 'Total']}
                  rows={report.vendorCredits.map((c) => [
                    c.vendor,
                    c.docNumber || '—',
                    c.txnDate,
                    fmtMoney(c.openBalance),
                    fmtMoney(c.total),
                  ])}
                  numericFrom={3}
                />
              </Section>
            )}

            <p className={`text-xs ${subText}`}>
              Generated {report.generatedAt} · QuickBooks realm: {report.location} · Ramp entity: {report.rampEntity} ·{' '}
              <a
                href={SOURCE_PROCEDURE_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:opacity-80"
              >
                Source procedure: “REFERENCE (DORMANT) — Weekly AP Aging Procedure” ↗
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

interface SharedStyle {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  theadBg: string;
  rowBorder: string;
}

function ErrorStrip({ darkMode, label, message }: { darkMode: boolean; label: string; message: string }) {
  return (
    <div
      className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
        darkMode ? 'bg-red-950/40 border-red-800 text-red-200' : 'bg-red-50 border-red-300 text-red-800'
      }`}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
      <p>
        <strong>{label}:</strong> {message}
      </p>
    </div>
  );
}

function Tile({ cardBg, subText, label, value, sub }: SharedStyle & { label: string; value: string; sub?: string }) {
  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg}`}>
      <p className={`text-xs font-medium ${subText}`}>{label}</p>
      <p className="text-lg font-bold mt-1">{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${subText}`}>{sub}</p>}
    </div>
  );
}

function Section({
  cardBg,
  subText,
  title,
  subtitle,
  children,
}: SharedStyle & { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className="p-4 pb-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className={`text-xs mt-0.5 ${subText}`}>{subtitle}</p>}
      </div>
      <div className="p-4 pt-2">{children}</div>
    </div>
  );
}

function SimpleTable({
  theadBg,
  rowBorder,
  subText,
  headers,
  rows,
  numericFrom,
}: SharedStyle & { headers: string[]; rows: React.ReactNode[][]; numericFrom?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={theadBg}>
            {headers.map((h, i) => (
              <th
                key={h}
                className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide ${subText} ${
                  numericFrom !== undefined && i >= numericFrom ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, ri) => (
            <tr key={ri} className={`border-b ${rowBorder}`}>
              {cells.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-2 align-top ${
                    numericFrom !== undefined && ci >= numericFrom ? 'text-right tabular-nums' : ''
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({
  tone,
  darkMode,
  icon,
  children,
}: {
  tone: 'info' | 'good' | 'warn' | 'stop' | 'neutral';
  darkMode: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = darkMode
    ? {
        info: 'bg-blue-950/60 text-blue-200 border-blue-800',
        good: 'bg-emerald-950/60 text-emerald-200 border-emerald-800',
        warn: 'bg-amber-950/60 text-amber-200 border-amber-800',
        stop: 'bg-red-950/60 text-red-200 border-red-800',
        neutral: 'bg-slate-700 text-slate-200 border-slate-600',
      }
    : {
        info: 'bg-blue-50 text-blue-700 border-blue-200',
        good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        warn: 'bg-amber-50 text-amber-800 border-amber-300',
        stop: 'bg-red-50 text-red-700 border-red-200',
        neutral: 'bg-slate-100 text-slate-600 border-slate-200',
      };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function AutoAchSection(props: SharedStyle & { batches: AutoAchBatch[]; cutoff: string }) {
  const { batches, cutoff, darkMode } = props;
  return (
    <Section
      {...props}
      title={`Proposed auto-ACH payments (${batches.length} batches)`}
      subtitle={`Rule: bills from “AutoPay” vendors due on or before ${cutoff} would be posted now, batched by vendor + due date (e.g. Medisca = one ACH per due date). PROPOSED ONLY — nothing has been posted in QuickBooks.`}
    >
      {batches.length === 0 ? (
        <Empty {...props} icon={<CheckCircle2 className="w-4 h-4" aria-hidden />} text="No auto-ACH bills fall inside the window." />
      ) : (
        <SimpleTable
          {...props}
          headers={['Vendor', 'Due date', 'Bills in batch', 'Batch total']}
          rows={batches.map((b) => [
            b.vendor,
            b.dueDate,
            <span key="bills">
              {b.bills.map((bill) => bill.invoiceNumber || '(no invoice #)').join(', ')}{' '}
              <Badge tone="warn" darkMode={darkMode} icon={<Info className="w-3 h-3" aria-hidden />}>
                proposed
              </Badge>
            </span>,
            fmtMoney(b.total),
          ])}
          numericFrom={3}
        />
      )}
    </Section>
  );
}

function DuplicatesSection(props: SharedStyle & { duplicates: DuplicateGroup[] }) {
  const { duplicates, darkMode } = props;
  return (
    <Section
      {...props}
      title={`Possible duplicate bills (${duplicates.length} groups)`}
      subtitle="Exact = same vendor + invoice number entered more than once. Suspected = same vendor, amount and due date under different invoice numbers — review before paying."
    >
      {duplicates.length === 0 ? (
        <Empty {...props} icon={<CheckCircle2 className="w-4 h-4" aria-hidden />} text="No duplicates detected in open AP." />
      ) : (
        <SimpleTable
          {...props}
          headers={['Type', 'Vendor', 'Shared', 'Bills (invoice · txn date · open balance)']}
          rows={duplicates.map((g) => [
            g.kind === 'exact' ? (
              <Badge key="t" tone="stop" darkMode={darkMode} icon={<Copy className="w-3 h-3" aria-hidden />}>
                exact
              </Badge>
            ) : (
              <Badge key="t" tone="warn" darkMode={darkMode} icon={<Copy className="w-3 h-3" aria-hidden />}>
                suspected
              </Badge>
            ),
            g.vendor,
            g.sharedKey,
            <ul key="bills" className="space-y-0.5">
              {g.bills.map((b) => (
                <li key={b.qbId}>
                  {(b.invoiceNumber || '(no invoice #)') + ' · ' + b.txnDate + ' · ' + fmtMoney(b.openBalance)}
                </li>
              ))}
            </ul>,
          ])}
        />
      )}
    </Section>
  );
}

function RampOrphansSection(props: SharedStyle & { orphans: RampOrphan[] }) {
  const { orphans, darkMode } = props;
  return (
    <Section
      {...props}
      title={`Ramp bills missing from open AP (${orphans.length})`}
      subtitle={`Amy's “Not There” rule: a Ramp bill that is gone from open AP was probably paid in QBO → candidate to mark paid in Ramp. Each candidate was cross-checked read-only against QuickBooks. No bill has been marked paid — action stays manual.`}
    >
      {orphans.length === 0 ? (
        <Empty {...props} icon={<CheckCircle2 className="w-4 h-4" aria-hidden />} text="Every unpaid Ramp bill is present on open AP." />
      ) : (
        <SimpleTable
          {...props}
          headers={['Vendor', 'Invoice #', 'Due', 'Ramp status', 'Pay method', 'QBO check', 'Amount']}
          rows={orphans.map((o) => [
            <span key="v">
              {o.vendor}{' '}
              {o.deepLinkUrl && (
                <a
                  href={o.deepLinkUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-blue-500 hover:underline text-xs"
                >
                  <Link2 className="w-3 h-3" aria-hidden />
                  QBO
                </a>
              )}
            </span>,
            o.invoiceNumber || '—',
            o.dueAt ?? '—',
            <Badge key="s" tone="neutral" darkMode={darkMode}>
              {o.status}
              {o.statusSummary ? ` · ${o.statusSummary}` : ''}
            </Badge>,
            o.paymentMethod ?? '—',
            <QboStateBadge key="q" state={o.qboState} darkMode={darkMode} />,
            fmtMoney(o.amount),
          ])}
          numericFrom={6}
        />
      )}
    </Section>
  );
}

function QboStateBadge({ state, darkMode }: { state: RampOrphan['qboState']; darkMode: boolean }) {
  switch (state) {
    case 'PAID_IN_QBO':
      return (
        <Badge tone="good" darkMode={darkMode} icon={<CheckCircle2 className="w-3 h-3" aria-hidden />}>
          paid in QBO → mark paid in Ramp
        </Badge>
      );
    case 'STILL_OPEN_IN_QBO':
      return (
        <Badge tone="warn" darkMode={darkMode} icon={<AlertTriangle className="w-3 h-3" aria-hidden />}>
          still open in QBO
        </Badge>
      );
    case 'NOT_FOUND_IN_QBO':
      return (
        <Badge tone="warn" darkMode={darkMode} icon={<AlertTriangle className="w-3 h-3" aria-hidden />}>
          not found in QBO
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral" darkMode={darkMode} icon={<Info className="w-3 h-3" aria-hidden />}>
          unverified
        </Badge>
      );
  }
}

const BUCKET_LABEL: Record<ApBillRow['agingBucket'], string> = {
  notDue: 'not due',
  '1-30': '1–30 past due',
  '31-60': '31–60 past due',
  '61-90': '61–90 past due',
  '90+': '90+ past due',
  noDueDate: 'no due date',
};

function OpenApSection(props: SharedStyle & { bills: ApBillRow[] }) {
  const { bills, darkMode } = props;
  const [filter, setFilter] = useState<'all' | 'window' | 'ramp'>('all');
  const filtered = useMemo(() => {
    if (filter === 'window') return bills.filter((b) => b.dueInWindow);
    if (filter === 'ramp') return bills.filter((b) => b.ramp !== null);
    return bills;
  }, [bills, filter]);

  return (
    <Section
      {...props}
      title={`Open AP (${bills.length} bills)`}
      subtitle="All unpaid bills, with aging, the AutoPay flag, and the Ramp Bill Pay cross-check. Bills paid by ACH/card through Ramp must never be marked paid in QBO — Ramp closes the QBO bill on vendor confirmation."
    >
      <div className="flex gap-2 mb-3">
        {(
          [
            ['all', 'All'],
            ['window', 'Due in window'],
            ['ramp', 'In Ramp Bill Pay'],
          ] as const
        ).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setFilter(val)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              filter === val
                ? 'bg-blue-600 text-white border-blue-600'
                : darkMode
                  ? 'bg-slate-700 text-slate-200 border-slate-600 hover:bg-slate-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <SimpleTable
        {...props}
        headers={['Vendor', 'Invoice #', 'Txn date', 'Due date', 'Aging', 'Flags', 'Open balance']}
        rows={filtered.map((b) => [
          b.vendor,
          b.invoiceNumber || '—',
          b.txnDate,
          b.dueDate ?? '—',
          <Badge
            key="aging"
            tone={b.agingBucket === 'notDue' ? 'neutral' : b.agingBucket === 'noDueDate' ? 'info' : 'warn'}
            darkMode={darkMode}
          >
            {BUCKET_LABEL[b.agingBucket]}
            {b.daysPastDue !== null && b.daysPastDue > 0 ? ` (${b.daysPastDue}d)` : ''}
          </Badge>,
          <span key="flags" className="inline-flex flex-wrap gap-1">
            {b.autoPayVendor && (
              <Badge tone="info" darkMode={darkMode} icon={<CircleDollarSign className="w-3 h-3" aria-hidden />}>
                AutoPay vendor
              </Badge>
            )}
            {b.ramp && (
              <Badge tone="neutral" darkMode={darkMode} icon={<Link2 className="w-3 h-3" aria-hidden />}>
                Ramp: {b.ramp.status}
                {b.ramp.paymentMethod ? ` · ${b.ramp.paymentMethod}` : ''}
              </Badge>
            )}
            {b.ramp?.doNotMarkPaidInQbo && (
              <Badge tone="stop" darkMode={darkMode} icon={<Ban className="w-3 h-3" aria-hidden />}>
                do NOT mark paid in QBO
              </Badge>
            )}
          </span>,
          fmtMoney(b.openBalance),
        ])}
        numericFrom={6}
      />
    </Section>
  );
}

function Empty({ subText, icon, text }: SharedStyle & { icon: React.ReactNode; text: string }) {
  return (
    <p className={`text-sm flex items-center gap-2 ${subText}`}>
      {icon}
      {text}
    </p>
  );
}
