'use client';

import { Fragment, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import HelpTip from './HelpTip';
import QboImportGuide from './QboImportGuide';
import CategoryLotDrilldown from './CategoryLotDrilldown';
import type { CategoryJE, CloseBasis, InvCloseHeader, InvCloseLine, LocationJE } from '@/types/inventory';
import {
  CLOSE_STATUS_LABEL as STATUS_LABEL,
  closeDisplayLines,
  findCloseHeader,
  invCloseDocNumber,
  shortInventoryLocation,
} from '@/lib/inventory/monthly-close';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Local mirror of qb-journal's QbJournalEntryPayload — that module pulls in the
 *  QuickBooks client and must never land in a client bundle. */
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
export interface QbJournalEntryPayload {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  Line: QbJournalEntryLine[];
}

/** A location's suggested numbers joined with its stored draft (when generated). */
interface LocationView {
  je: LocationJE;
  header: InvCloseHeader | null;
  storedLines: InvCloseLine[];
}

/**
 * Inventory-close JE per location, in the End of Month tab's draft-card style —
 * sub-tab per location + Combined, with the same Approve / Dry run / Post
 * workflow once drafts are generated. Until then each card shows the live
 * suggested numbers.
 */
export default function JournalEntryPanel({
  journalEntries,
  categoryJournalEntries,
  basis,
  monthEnd,
  month,
  darkMode,
  headers,
  linesById,
  busyHeaderId,
  dryRunPayloads,
  onApprove,
  onDryRun,
  onPostLive,
}: {
  journalEntries: LocationJE[];
  categoryJournalEntries: CategoryJE[];
  basis: CloseBasis;
  monthEnd: string;
  month: string;
  darkMode: boolean;
  headers: InvCloseHeader[];
  linesById: Record<string, InvCloseLine[]>;
  busyHeaderId: number | null;
  dryRunPayloads: Record<number, QbJournalEntryPayload>;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  const views = useMemo<LocationView[]>(
    () =>
      journalEntries.map((je) => {
        const header = findCloseHeader(je.location, headers);
        return { je, header, storedLines: header ? (linesById[String(header.id)] ?? []) : [] };
      }),
    [journalEntries, headers, linesById],
  );

  const [tab, setTab] = useState<string>('first');
  const activeLocation = tab === 'first' ? (views[0]?.je.location ?? 'combined') : tab;
  const activeView = views.find((v) => v.je.location === activeLocation) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          Adjusting journal entry
          <HelpTip
            label="What this entry does"
            text="Books the difference between the FIFO ending value and the QuickBooks inventory-asset book balance, per location — it restates the inventory asset to the FIFO figure. Generate drafts, review, approve, then post; nothing reaches QuickBooks without an explicit approve + post."
          />
        </p>
        {headers.length === 0 && (
          <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
            Suggested only — generate drafts to enable posting
          </span>
        )}
      </div>

      {/* Sub-tab bar — one tab per location + Combined (mirrors the End of Month drafts). */}
      <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
        {views.map((v) => (
          <button
            key={v.je.location}
            onClick={() => setTab(v.je.location)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              activeLocation === v.je.location
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'text-slate-300 hover:bg-slate-700'
                  : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {shortInventoryLocation(v.je.location)} ·{' '}
            {v.header ? STATUS_LABEL[v.header.status] : v.je.bookAvailable ? 'Suggested' : 'No QB balance'}
          </button>
        ))}
        <button
          onClick={() => setTab('combined')}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
            activeLocation === 'combined'
              ? 'bg-blue-600 text-white'
              : darkMode
                ? 'text-slate-300 hover:bg-slate-700'
                : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Combined
        </button>
      </div>

      {activeView ? (
        <DraftCard
          darkMode={darkMode}
          cardBg={cardBg}
          subText={subText}
          border={border}
          view={activeView}
          categoryJE={categoryJournalEntries.find((c) => c.location === activeView.je.location) ?? null}
          basis={basis}
          month={month}
          monthEnd={monthEnd}
          busy={activeView.header !== null && busyHeaderId === activeView.header.id}
          dryRunPayload={activeView.header ? (dryRunPayloads[activeView.header.id] ?? null) : null}
          onApprove={onApprove}
          onDryRun={onDryRun}
          onPostLive={onPostLive}
        />
      ) : (
        <CombinedCard
          cardBg={cardBg}
          subText={subText}
          border={border}
          views={views}
          basis={basis}
          month={month}
          monthEnd={monthEnd}
        />
      )}
    </div>
  );
}

/**
 * Amber context note shown when the adjustment is disproportionately large
 * (> 25% of the bigger of |FIFO target| and |book balance|). A first-ever close
 * against a plug-maintained book balance produces exactly this, and without the
 * explanation the number reads like an error.
 */
function LargeAdjustmentNote({ darkMode, je }: { darkMode: boolean; je: LocationJE }) {
  if (je.adjustment === null || je.qbBookBalance === null) return null;
  const scale = Math.max(Math.abs(je.fifoTarget), Math.abs(je.qbBookBalance), 1);
  if (Math.abs(je.adjustment) <= 0.25 * scale) return null;
  return (
    <div
      className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
        darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
      }`}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
      <p>
        <span className="font-semibold">This adjustment is large — that is expected on a first close, not a
        red flag.</span>{' '}
        The QuickBooks balance was maintained with rough monthly estimates and has never been tied to an
        actual valuation, so this entry is catching up <em>years</em> of accumulated drift in one step —
        it does not mean inventory moved by this much in one month. Note the offset lands in Cost of Goods
        Sold for this month, which will distort that month&rsquo;s margin. Worth confirming treatment with
        the CPA (post as-is, or split/backdate the catch-up) before posting.
      </p>
    </div>
  );
}

/**
 * Per-category breakdown of a location's entry, each row expandable to the lots
 * behind it. This is what the CPA substantiates from: line -> category -> lots.
 */
function CategoryBreakdown({
  je,
  month,
  darkMode,
  subText,
  border,
  hasDraft,
}: {
  je: CategoryJE;
  month: string;
  darkMode: boolean;
  subText: string;
  border: string;
  /** true once a draft exists — the table below it is then the FROZEN stored
   *  draft while these numbers stay LIVE, and the two can legitimately disagree. */
  hasDraft: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  if (je.lines.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-sm font-semibold flex items-center gap-1.5">
        {hasDraft ? 'Category detail — live' : 'By inventory category — what generates'}
        <HelpTip
          label="Category detail"
          text={
            'Each category is valued from its own lots (the lot-depletion ledger) and compared against its own QuickBooks sub-account, so the entry can be substantiated category by category. This is what Generate drafts builds the entry from. Click a row to see the products and lots behind it.' +
            (hasDraft
              ? ' These figures are recomputed LIVE on every load, while the stored draft below was frozen when it was generated — if the lot ledger has been re-simulated since, the two will differ, and the stored draft is what posts.'
              : '')
          }
        />
      </p>
      {hasDraft && (
        <p className={`text-xs ${subText}`}>
          Recomputed live — the stored draft below is frozen at generation and is what posts.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${border}`}>
              <th className={th}>Category</th>
              <th className={th}>QB account</th>
              <th className={`${th} text-right`}>FIFO (lots)</th>
              <th className={`${th} text-right`}>QB book</th>
              <th className={`${th} text-right`}>Adjustment</th>
              <th className={`${th} text-right`}>Lots</th>
            </tr>
          </thead>
          <tbody>
            {je.lines.map((l) => (
              <Fragment key={l.qbCategory}>
                <tr
                  onClick={() => setOpen((v) => (v === l.qbCategory ? null : l.qbCategory))}
                  className={`border-b last:border-0 cursor-pointer ${border} ${
                    darkMode ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="px-2 py-1 font-medium flex items-center gap-1">
                    {open === l.qbCategory ? (
                      <ChevronDown className="w-3 h-3 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0" aria-hidden />
                    )}
                    {l.qbCategory}
                    {!l.mapped && (
                      <span
                        title="No QuickBooks category account — posts to the parent account as a residual. Assign drug codes to clear."
                        className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-600 font-semibold uppercase cursor-help"
                      >
                        residual
                      </span>
                    )}
                  </td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.inventoryAccount}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{usd.format(l.fifoTarget)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {l.qbBookBalance === null ? '—' : usd.format(l.qbBookBalance)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-medium">
                    {l.adjustment === null ? '—' : usd.format(l.adjustment)}
                  </td>
                  <td className={`px-2 py-1 text-right ${subText}`}>{l.lotCount}</td>
                </tr>
                {open === l.qbCategory && (
                  <tr>
                    <td colSpan={6} className={darkMode ? 'bg-slate-800/60' : 'bg-slate-50'}>
                      <CategoryLotDrilldown
                        location={je.location}
                        qbCategory={l.qbCategory}
                        month={month}
                        darkMode={darkMode}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {/* The categorized total — the figure the entry actually posts. Without
              it a reviewer has to add the category rows up by hand. */}
          <tfoot>
            <tr className={`border-t font-semibold ${border}`}>
              <td className="px-2 py-1.5" colSpan={2}>
                Categorized total
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{usd.format(je.fifoTarget)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {je.bookAvailable ? usd.format(round2(je.fifoTarget - je.adjustment)) : '—'}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: '#2563eb' }}>
                {je.bookAvailable ? usd.format(je.adjustment) : '—'}
              </td>
              <td className={`px-2 py-1.5 text-right ${subText}`}>
                {je.lines.reduce((s, l) => s + l.lotCount, 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {je.unmappedCategories.length > 0 && (
        <p className={`text-xs ${subText}`}>
          Residual categories ({je.unmappedCategories.join(', ')}) share the parent Inventory Asset /
          Cost of Goods Sold accounts, so they post as <strong>one combined line</strong> — the parent
          book balance can only be subtracted once.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ darkMode, label }: { darkMode: boolean; label: string }) {
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

/** Rows the tables render — one selection rule shared with the xlsx export
 *  (closeDisplayLines): stored draft lines when a draft exists (that is what
 *  will post), the live suggestion otherwise. */
function displayLines(view: LocationView, basis: CloseBasis, monthEnd: string): InvCloseLine[] {
  return closeDisplayLines(view.je, view.header, view.storedLines, basis, monthEnd);
}

function DraftCard({
  darkMode,
  cardBg,
  subText,
  border,
  view,
  categoryJE,
  basis,
  month,
  monthEnd,
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
  view: LocationView;
  categoryJE: CategoryJE | null;
  basis: CloseBasis;
  month: string;
  monthEnd: string;
  busy: boolean;
  dryRunPayload: QbJournalEntryPayload | null;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
}) {
  const { je, header } = view;
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const posted = header?.status === 'posted';
  const [qboGuideOpen, setQboGuideOpen] = useState(false);
  const docNumber = posted ? (header?.qb_doc_number ?? '—') : invCloseDocNumber(je.location, month);
  const lines = displayLines(view, basis, monthEnd);
  const debitTotal = round2(lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const creditTotal = round2(lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{je.location}</p>
          <p className={`text-xs ${subText}`}>
            {docNumber} · {header?.txn_date ?? monthEnd}
          </p>
        </div>
        <StatusBadge
          darkMode={darkMode}
          label={header ? STATUS_LABEL[header.status] : je.bookAvailable ? 'Suggested' : 'Book balance unavailable'}
        />
      </div>

      {!je.bookAvailable && !header ? (
        <div
          className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
            darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            FIFO target {usd.format(je.fifoTarget)} — reconnect the QuickBooks realm to pull the book
            balance and compute the adjustment.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className={`rounded-lg border p-3 ${border}`}>
              <p className={`text-xs flex items-center gap-1.5 ${subText}`}>
                FIFO target
                <HelpTip
                  label="FIFO target"
                  text="What this close is bringing the books to: month-end stock valued at the actual purchase price of the lots it sits in, on the selected basis (receipt-priced floor or full-coverage estimate)."
                />
              </p>
              <p className="text-lg font-bold tabular-nums">{usd.format(je.fifoTarget)}</p>
            </div>
            <div className={`rounded-lg border p-3 ${border}`}>
              <p className={`text-xs flex items-center gap-1.5 ${subText}`}>
                QB book balance
                <HelpTip
                  label="QB book balance"
                  text="The inventory-asset balance in QuickBooks at month end. Historically it was maintained with rough monthly write-off estimates rather than a valuation, so it drifts from reality over time — it is the number being corrected, not a benchmark."
                />
              </p>
              <p className="text-lg font-bold tabular-nums">{usd.format(je.qbBookBalance ?? 0)}</p>
            </div>
            <div className={`rounded-lg border p-3 ${border}`}>
              <p className={`text-xs flex items-center gap-1.5 ${subText}`}>
                Adjustment (rollback ref.)
                <HelpTip
                  label="Rollback reference — not the categorized total"
                  text="These three figures come from the backward-rollback valuation, the reference method: FIFO target minus the QB book balance. The number that actually posts is the Categorized total in the by-category table below, summed from the lot ledger — for non-anchored months the two differ substantially. A large adjustment either way is not one month of activity: the book balance carries years of accumulated estimates that were never tied to a valuation, so the first close catches up all of that drift in a single entry. The offset posts to Cost of Goods Sold."
                />
              </p>
              <p className="text-lg font-bold tabular-nums" style={{ color: '#2563eb' }}>
                {usd.format(je.adjustment ?? 0)}
              </p>
            </div>
          </div>

          <LargeAdjustmentNote darkMode={darkMode} je={je} />

          {categoryJE && (
            <CategoryBreakdown
              key={categoryJE.location}
              je={categoryJE}
              month={month}
              darkMode={darkMode}
              subText={subText}
              border={border}
              hasDraft={header !== null}
            />
          )}

          {lines.length === 0 ? (
            <p className={`text-sm ${subText}`}>No adjustment needed — FIFO ties to the book balance.</p>
          ) : (
            <div className="overflow-x-auto space-y-1">
              {/* WHAT THESE ROWS ARE depends on whether a draft exists — with one
                  they are the frozen stored lines (what posts); without one
                  closeDisplayLines falls back to the single-pair ROLLBACK
                  suggestion, which is NOT what Generate would produce. Saying so
                  here beats a paragraph above the panel. */}
              <p className="text-sm font-semibold flex items-center gap-1.5">
                {header ? 'Stored draft — frozen at generation' : 'Rollback method — reference only (not what generates)'}
                <HelpTip
                  label={header ? 'Stored draft' : 'Rollback reference'}
                  text={
                    header
                      ? 'The lines frozen into the draft when it was generated — these are exactly what posts to QuickBooks. The category table above is recomputed live, so if the lot ledger has been re-simulated since generation the two will differ. Regenerate to refresh the draft.'
                      : 'A single debit/credit pair built from the backward-rollback valuation against the parent accounts — the OTHER method, shown for reference. Generate drafts builds from the category detail above instead, on its own sub-accounts, and the two totals differ substantially for months that are not LifeFile-anchored.'
                  }
                />
              </p>
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
                    <tr key={`${l.accountName}-${i}`} className={`border-b last:border-0 ${border}`}>
                      <td className={`px-2 py-1 text-xs ${subText}`}>{l.postingType}</td>
                      <td className="px-2 py-1">{l.accountName}</td>
                      <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {l.postingType === 'Debit' ? usd.format(l.amount) : ''}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {l.postingType === 'Credit' ? usd.format(l.amount) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={`border-t font-semibold ${border}`}>
                    <td className="px-2 py-1" colSpan={3}>
                      Total
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{usd.format(debitTotal)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{usd.format(creditTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {header && !posted && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setQboGuideOpen(true)}
                title={
                  `Download ${docNumber} as a CSV formatted for QuickBooks journal-entry import ` +
                  `(Settings → Import data → Journal entries). One file per company — import this one into ${je.location}. ` +
                  'Opens an import checklist first (QuickBooks requires account numbers OFF to import).'
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
                entity={je.location}
                href={`/api/payroll/export?headerId=${header.id}&format=qbo`}
              />
              <button
                onClick={() => onApprove(header.id)}
                disabled={busy || header.status === 'approved'}
                title="Marks the draft reviewed and unlocks posting — approval alone sends nothing to QuickBooks"
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldCheck className="w-4 h-4" aria-hidden />}
                {header.status === 'approved' ? 'Approved' : 'Approve'}
              </button>
              <button
                onClick={() => onDryRun(header.id)}
                disabled={busy}
                title="Builds the exact QuickBooks payload and previews it below — nothing is sent"
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border disabled:opacity-50 ${
                  darkMode ? 'border-slate-600 text-slate-100 hover:bg-slate-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
                Dry run
              </button>
              <button
                onClick={() => onPostLive(header.id, je.location)}
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
        </>
      )}
    </div>
  );
}

/** Read-only merged view of every location's lines (mirrors the End of Month
 *  Combined grid): each line with its entity, one totals row. */
function CombinedCard({
  cardBg,
  subText,
  border,
  views,
  basis,
  month,
  monthEnd,
}: {
  cardBg: string;
  subText: string;
  border: string;
  views: LocationView[];
  basis: CloseBasis;
  month: string;
  monthEnd: string;
}) {
  const rows = views.flatMap((v) =>
    displayLines(v, basis, monthEnd).map((l, i) => ({
      ...l,
      location: v.je.location,
      _key: `${v.je.location}-${i}`,
    })),
  );
  const debitTotal = round2(rows.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
  const creditTotal = round2(rows.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`px-4 py-3 border-b ${border} flex items-center justify-between`}>
        <p className="text-sm font-semibold">Combined — all locations, {month}</p>
        <p className={`text-xs ${subText}`}>read-only · approve and post on each location&apos;s tab</p>
      </div>
      {rows.length === 0 ? (
        <p className={`px-4 py-6 text-sm ${subText}`}>
          No adjustments needed — FIFO ties to the book balance at every location.
        </p>
      ) : (
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
                  <td className={`px-2 py-1 text-xs whitespace-nowrap ${subText}`}>{shortInventoryLocation(l.location)}</td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.postingType}</td>
                  <td className="px-2 py-1">{l.accountName}</td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {l.postingType === 'Debit' ? usd.format(l.amount) : ''}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {l.postingType === 'Credit' ? usd.format(l.amount) : ''}
                  </td>
                </tr>
              ))}
              <tr className={`border-t font-semibold ${border}`}>
                <td className="px-2 py-2" colSpan={4}>
                  Totals
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{usd.format(debitTotal)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{usd.format(creditTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
