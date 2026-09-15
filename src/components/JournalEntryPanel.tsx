'use client';

import { Fragment, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import HelpTip from './HelpTip';
import QboImportGuide from './QboImportGuide';
import JeSourceWorkbookLink from './JeSourceWorkbookLink';
import CategoryLotDrilldown from './CategoryLotDrilldown';
import CategoryCogsByMonth from './CategoryCogsByMonth';
import { formatAccount } from '@/lib/inventory/account-label';
import type {
  CategoryCogsSeriesRow,
  CategoryJE,
  CategoryRollForwardRow,
  CloseBasis,
  InvCloseHeader,
  InvCloseLine,
  LocationJE,
} from '@/types/inventory';
import {
  CLOSE_STATUS_LABEL as STATUS_LABEL,
  categoryKey,
  closeDisplayLines,
  findCloseHeader,
  invCloseDocNumber,
  shortInventoryLocation,
  sortByLocation,
  sumCents,
} from '@/lib/inventory/monthly-close';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Deep link into the Inventory Valuation page, scoped to exactly the cell that
 * was clicked. That page reads the same lot-ledger grain this entry posts from,
 * so the figure a reviewer lands on is the figure they left — the link is only
 * worth having as long as that stays true.
 *
 * `from=close` makes the destination offer a way back here.
 */
function asOfHref(month: string, location: string, category?: string): string {
  const q = new URLSearchParams({ month, location, from: 'close' });
  if (category) q.set('category', category);
  return `/inventory?${q.toString()}`;
}

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
  categoryRollForward,
  categoryCogsSeries,
  firstAnchoredMonth,
  basis,
  monthEnd,
  month,
  darkMode,
  headers,
  linesById,
  busyHeaderId,
  dryRunPayloads,
  accountNumbers,
  onApprove,
  onDryRun,
  onPostLive,
  onUnpost,
}: {
  journalEntries: LocationJE[];
  categoryJournalEntries: CategoryJE[];
  categoryRollForward: CategoryRollForwardRow[];
  categoryCogsSeries: CategoryCogsSeriesRow[];
  firstAnchoredMonth: string | null;
  basis: CloseBasis;
  monthEnd: string;
  month: string;
  darkMode: boolean;
  headers: InvCloseHeader[];
  linesById: Record<string, InvCloseLine[]>;
  busyHeaderId: number | null;
  dryRunPayloads: Record<number, QbJournalEntryPayload>;
  /** RDS location -> (FullyQualifiedName -> AcctNum), so lines print '1220.05 …'. */
  accountNumbers: Record<string, Record<string, string>>;
  /** Delete a posted entry from QuickBooks and return it to a draft. */
  onUnpost: (headerId: number, entityLabel: string, docNumber: string) => void;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  // FL → TN → TX, the same order as the roll-forward above (sortByLocation), so
  // the selector and the table never disagree on who is first.
  const views = useMemo<LocationView[]>(
    () =>
      sortByLocation(journalEntries, (je) => je.location).map((je) => {
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
          categoryRollForward={categoryRollForward}
          categoryCogsSeries={categoryCogsSeries}
          firstAnchoredMonth={firstAnchoredMonth}
          basis={basis}
          month={month}
          monthEnd={monthEnd}
          busy={activeView.header !== null && busyHeaderId === activeView.header.id}
          dryRunPayload={activeView.header ? (dryRunPayloads[activeView.header.id] ?? null) : null}
          accountNumbers={accountNumbers[activeView.je.location] ?? {}}
          onApprove={onApprove}
          onDryRun={onDryRun}
          onPostLive={onPostLive}
          onUnpost={onUnpost}
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
          accountNumbers={accountNumbers}
        />
      )}
    </div>
  );
}

/** Below this many dollars an adjustment is never "large", whatever the ratio. */
const LARGE_ADJUSTMENT_FLOOR = 2500;

/**
 * Amber context note shown when the adjustment is disproportionately large
 * (> 25% of the bigger of |FIFO target| and |book balance|, AND at least
 * LARGE_ADJUSTMENT_FLOOR in dollars). A first-ever close
 * against a plug-maintained book balance produces exactly this, and without the
 * explanation the number reads like an error.
 */
function LargeAdjustmentNote({
  darkMode,
  fifoTarget,
  qbBookBalance,
  adjustment,
  anchored,
}: {
  darkMode: boolean;
  fifoTarget: number;
  qbBookBalance: number | null;
  adjustment: number | null;
  /** True on a count-anchored month (2025-12 onward): the figures are the ledger's. */
  anchored: boolean;
}) {
  if (adjustment === null || qbBookBalance === null) return null;
  const scale = Math.max(Math.abs(fifoTarget), Math.abs(qbBookBalance), 1);
  if (Math.abs(adjustment) <= 0.25 * scale) return null;
  // Relative alone is not enough: TX January 2026 was a −$34.01 adjustment on a
  // $39 balance — 87%, and the banner talked about "years of accumulated drift".
  // Carson, 2026-09-15: "the texas january posting has the large adjustment flag
  // still?" A catch-up worth the explanation is also large in dollars.
  if (Math.abs(adjustment) < LARGE_ADJUSTMENT_FLOOR) return null;
  const bookAboveFifo = adjustment < 0;
  return (
    <div
      className={`rounded-xl border p-3 flex gap-2 items-start text-sm ${
        darkMode ? 'bg-amber-950/30 border-amber-800 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
      }`}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
      {anchored ? (
        // 2026 months. From March 2026 QuickBooks capitalised every drug and packaging
        // purchase into 1220.xx and nothing relieved it, so the book runs a full month
        // of purchases ahead of the counted stock each month. The entry moves that into
        // Cost of Goods Sold — it IS the month's COGS being recognised. Carson,
        // 2026-09-15: "it's firing for every single month, can we update it accordingly
        // for what it really is warning about and why the adjustments are so large".
        <p>
          <span className="font-semibold">
            {bookAboveFifo
              ? 'Large because the book is carrying unrelieved purchases — this entry is the month’s COGS.'
              : 'Large because the book sits well below the counted stock.'}
          </span>{' '}
          {bookAboveFifo ? (
            <>
              Since March 2026, purchases have been capitalised into the inventory accounts in QuickBooks with
              no monthly relief to Cost of Goods Sold, so the book balance grows by roughly a month of
              purchases every month while the counted FIFO stock moves only by purchases minus usage. The
              difference here is that month&rsquo;s (and any earlier unposted month&rsquo;s) purchases being
              recognised as COGS. Post the months in order and regenerate each one after the previous post;
              once the prior month is in QuickBooks, the adjustment shrinks to purchases minus usage for the
              month, and this note stops appearing.
            </>
          ) : (
            <>
              The counted FIFO stock exceeds the inventory accounts in QuickBooks by this much, so the entry
              adds it back to inventory and credits Cost of Goods Sold. On a month right after a posted
              true-up this usually means purchases were expensed straight to COGS rather than capitalised;
              check the prior month posted and this draft was regenerated after it.
            </>
          )}
        </p>
      ) : (
        <p>
          <span className="font-semibold">This adjustment is large — that is expected on a first close, not a
          red flag.</span>{' '}
          The QuickBooks balance was maintained with rough monthly estimates and has never been tied to an
          actual valuation, so this entry is catching up <em>years</em> of accumulated drift in one step —
          it does not mean inventory moved by this much in one month. Note the offset lands in Cost of Goods
          Sold for this month, which will distort that month&rsquo;s margin. Worth confirming treatment with
          the CPA (post as-is, or split/backdate the catch-up) before posting.
        </p>
      )}
    </div>
  );
}

/**
 * Per-category breakdown of a location's entry, each row expandable to the lots
 * behind it. This is what the CPA substantiates from: line -> category -> lots.
 */
function CategoryBreakdown({
  je,
  categoryRollForward,
  categoryCogsSeries,
  firstAnchoredMonth,
  month,
  darkMode,
  subText,
  border,
  hasDraft,
}: {
  je: CategoryJE;
  categoryRollForward: CategoryRollForwardRow[];
  categoryCogsSeries: CategoryCogsSeriesRow[];
  firstAnchoredMonth: string | null;
  month: string;
  darkMode: boolean;
  subText: string;
  border: string;
  /** true once a draft exists — the table below it is then the FROZEN stored
   *  draft while these numbers stay LIVE, and the two can legitimately disagree. */
  hasDraft: boolean;
}) {
  // (location, category) -> this month's movement. The comparison rows and the
  // roll-forward rows are separate cuts of the same close, joined on the shared
  // categoryKey rather than a second hand-rolled key format.
  const movementByKey = new Map<string, CategoryRollForwardRow>();
  for (const r of categoryRollForward) movementByKey.set(categoryKey(r.location, r.qbCategory), r);

  const [open, setOpen] = useState<string | null>(null);
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const categorizedTotal = sumCents(je.lines.map((l) => l.fifoTarget));
  if (je.lines.length === 0) return null;

  // A residual category ('Uncoded', 'Opening Balance') whose every figure is zero —
  // no stock, no book balance, no movement this month — is old depleted lots still
  // carrying the stamp. It contributes nothing and is not a task, so it is not a
  // row. Carson, 2026-09-15, January FL: "uncoded still exists" over nine $0 lots.
  // Mapped categories always show; a residual with ANY dollars still shows.
  const visibleLines = je.lines.filter((l) => {
    if (l.mapped) return true;
    const mv = movementByKey.get(categoryKey(je.location, l.qbCategory));
    const moved = (mv?.beginning ?? 0) !== 0 || (mv?.purchases ?? 0) !== 0 || (mv?.cogs ?? 0) !== 0;
    return l.fifoTarget !== 0 || (l.qbBookBalance ?? 0) !== 0 || (l.adjustment ?? 0) !== 0 || moved;
  });

  // Beginning / purchases / COGS summed over every category row of this location
  // (the same movement rows the visible lines read), for the total row. A null
  // beginning or COGS anywhere (window start) makes the total null too.
  const movementTotals = je.lines.reduce<{ beginning: number | null; purchases: number; cogs: number | null }>(
    (acc, l) => {
      const mv = movementByKey.get(categoryKey(je.location, l.qbCategory));
      if (!mv) return acc;
      return {
        beginning: acc.beginning === null || mv.beginning === null ? null : round2(acc.beginning + mv.beginning),
        purchases: round2(acc.purchases + mv.purchases),
        cogs: acc.cogs === null || mv.cogs === null ? null : round2(acc.cogs + mv.cogs),
      };
    },
    { beginning: 0, purchases: 0, cogs: 0 },
  );

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
              <th className={`${th} text-right`}>Beginning</th>
              <th className={`${th} text-right`}>Purchases</th>
              <th className={`${th} text-right`} title="What moved from beginning to ending: beginning + purchases - ending">
                COGS
              </th>
              <th className={`${th} text-right`}>FIFO (lots)</th>
              <th className={`${th} text-right`}>QB book</th>
              <th className={`${th} text-right`}>Adjustment</th>
              <th className={`${th} text-right`}>Lots</th>
            </tr>
          </thead>
          <tbody>
            {visibleLines.map((l) => (
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
                    {/* stopPropagation: the row itself toggles the inline
                        drill-down, so without it following the link would also
                        expand the row it is leaving. */}
                    <a
                      href={asOfHref(month, je.location, l.qbCategory)}
                      onClick={(e) => e.stopPropagation()}
                      title="Open this category on the Point-in-Time Inventory Value page — the same figure, with full product and receipt detail"
                      className="ml-1 text-[11px] font-normal underline opacity-70 hover:opacity-100"
                    >
                      open ↗
                    </a>
                  </td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.inventoryAccount}</td>
                  {(() => {
                    const mv = movementByKey.get(categoryKey(je.location, l.qbCategory));
                    return (
                      <>
                        <td className={`px-2 py-1 text-right tabular-nums ${subText}`}>
                          {mv?.beginning == null ? '—' : usd.format(mv.beginning)}
                        </td>
                        <td className={`px-2 py-1 text-right tabular-nums ${subText}`}>
                          {mv === undefined ? '—' : usd.format(mv.purchases)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {mv?.cogs == null ? '—' : usd.format(mv.cogs)}
                        </td>
                      </>
                    );
                  })()}
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
                <a
                  href={asOfHref(month, je.location)}
                  title="Open this location on the Point-in-Time Inventory Value page — the same total, cut by category and traceable to receipts"
                  className="ml-2 text-[11px] font-normal underline opacity-70 hover:opacity-100"
                >
                  open ↗
                </a>
              </td>
              {/* The three movement columns, summed over the same rows, so the
                  total row lines up under its headers. Without them the FIFO /
                  QB / Adjustment figures slid three columns left and the
                  adjustment read as this month's COGS — Carson, 2026-09-15:
                  "why do the TN cogs in the table and the journal entry table
                  not agree on COGS". */}
              <td className="px-2 py-1.5 text-right tabular-nums">
                {movementTotals.beginning === null ? '—' : usd.format(movementTotals.beginning)}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{usd.format(movementTotals.purchases)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {movementTotals.cogs === null ? '—' : usd.format(movementTotals.cogs)}
              </td>
              {/* Totalled from the rows above with sumCents, not from the raw
                  float, so this equals both the visible lines and the same
                  month's headline on the Point-in-Time page. */}
              <td className="px-2 py-1.5 text-right tabular-nums">{usd.format(categorizedTotal)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {je.bookAvailable ? usd.format(round2(categorizedTotal - je.adjustment)) : '—'}
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
      <CategoryCogsByMonth
        rows={categoryCogsSeries}
        location={je.location}
        firstAnchoredMonth={firstAnchoredMonth}
        darkMode={darkMode}
        subText={subText}
        border={border}
      />
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

/** The exact QuickBooks payload a dry run built, shown under the entry it belongs to.
 *  Exported because every posting card must render it: the correction card and the
 *  lab-accrual card ran the dry run but never showed the result (Carson, 2026-09-14:
 *  "Dry run on the year end correction doesn't do anything?"). */
export function DryRunPreview({ darkMode, payload }: { darkMode: boolean; payload: QbJournalEntryPayload }) {
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
  categoryRollForward,
  categoryCogsSeries,
  firstAnchoredMonth,
  basis,
  month,
  monthEnd,
  busy,
  dryRunPayload,
  accountNumbers,
  onApprove,
  onDryRun,
  onPostLive,
  onUnpost,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  view: LocationView;
  categoryJE: CategoryJE | null;
  categoryRollForward: CategoryRollForwardRow[];
  categoryCogsSeries: CategoryCogsSeriesRow[];
  firstAnchoredMonth: string | null;
  basis: CloseBasis;
  month: string;
  monthEnd: string;
  busy: boolean;
  dryRunPayload: QbJournalEntryPayload | null;
  /** This company's FullyQualifiedName -> AcctNum map. */
  accountNumbers: Record<string, string>;
  onApprove: (headerId: number) => void;
  onDryRun: (headerId: number) => void;
  onPostLive: (headerId: number, entityLabel: string) => void;
  onUnpost: (headerId: number, entityLabel: string, docNumber: string) => void;
}) {
  const { je, header } = view;
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const posted = header?.status === 'posted';
  const [qboGuideOpen, setQboGuideOpen] = useState(false);
  // A posted entry collapses to a receipt (Carson, 2026-09-14: "if it's already
  // posted, just change to a receipt and a link"), with the detail one click away
  // and the pull-back that deletes it from QuickBooks for a regenerate + repost.
  const [showPostedDetail, setShowPostedDetail] = useState(false);
  const docNumber = posted ? (header?.qb_doc_number ?? '—') : invCloseDocNumber(je.location, month);

  // Which figures head the card. On a count-anchored month the categorized entry is
  // the truth and the rollback reference is noise — Carson, 2026-09-15: "why does
  // January have the large adjustment warning when we moved that to December?" The
  // January banner fired off the rollback's $75k while the entry that posts was
  // −$1,376. So: anchored → the categorized totals (what posts); otherwise the
  // rollback reference as before.
  const anchored = firstAnchoredMonth !== null && month >= firstAnchoredMonth && categoryJE !== null;
  const headline: { fifoTarget: number; qbBookBalance: number | null; adjustment: number | null } =
    anchored && categoryJE
      ? {
          fifoTarget: categoryJE.fifoTarget,
          qbBookBalance: categoryJE.bookAvailable
            ? categoryJE.lines.reduce((s, l) => s + (l.qbBookBalance ?? 0), 0)
            : null,
          adjustment: categoryJE.bookAvailable ? categoryJE.adjustment : null,
        }
      : { fifoTarget: je.fifoTarget, qbBookBalance: je.qbBookBalance, adjustment: je.adjustment };

  if (posted && header && !showPostedDetail) {
    return (
      <div className={`rounded-xl shadow-sm ${cardBg} border-2 ${darkMode ? 'border-emerald-800' : 'border-emerald-300'} p-4 space-y-2`}>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <p className="text-sm font-semibold flex items-center gap-2">
              {je.location} — posted to QuickBooks
              <StatusBadge darkMode={darkMode} label={STATUS_LABEL[header.status]} />
            </p>
            <p className={`text-xs ${subText}`}>
              {docNumber} · {header.txn_date ?? monthEnd} · Dr {usd.format(header.total_debits)}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <JeSourceWorkbookLink headerId={header.id} docNumber={docNumber} darkMode={darkMode} compact />
            <button
              onClick={() => setShowPostedDetail(true)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                darkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              Show detail
            </button>
            <button
              onClick={() => onUnpost(header.id, je.location, docNumber)}
              disabled={busy}
              title="Delete this entry from QuickBooks and return it to a draft, so it can be regenerated and reposted"
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-50 ${
                darkMode ? 'border-red-800 text-red-300 hover:bg-red-950/40' : 'border-red-300 text-red-700 hover:bg-red-50'
              }`}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin inline" aria-hidden /> : 'Pull back from QuickBooks'}
            </button>
          </div>
        </div>
      </div>
    );
  }
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
        <span className="flex items-center gap-2">
          {posted && (
            <button
              onClick={() => setShowPostedDetail(false)}
              className={`px-2 py-0.5 text-xs font-medium rounded-lg border ${
                darkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              Collapse
            </button>
          )}
          <StatusBadge
            darkMode={darkMode}
            label={header ? STATUS_LABEL[header.status] : je.bookAvailable ? 'Suggested' : 'Book balance unavailable'}
          />
        </span>
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
                  text={
                    anchored
                      ? 'What this close is bringing the books to: month-end stock by category, summed from the count-anchored lot ledger (the same figures as the by-category table below).'
                      : 'What this close is bringing the books to: month-end stock valued at the actual purchase price of the lots it sits in (receipt-priced).'
                  }
                />
              </p>
              <p className="text-lg font-bold tabular-nums">{usd.format(headline.fifoTarget)}</p>
            </div>
            <div className={`rounded-lg border p-3 ${border}`}>
              <p className={`text-xs flex items-center gap-1.5 ${subText}`}>
                QuickBooks balance
                <HelpTip
                  label="QuickBooks balance"
                  text={
                    anchored
                      ? 'The in-scope inventory sub-account balances in QuickBooks at month end, summed — the number being corrected.'
                      : 'The inventory-asset balance in QuickBooks at month end. Historically it was maintained with rough monthly write-off estimates rather than a valuation, so it drifts from reality over time — it is the number being corrected, not a benchmark.'
                  }
                />
              </p>
              <p className="text-lg font-bold tabular-nums">{usd.format(headline.qbBookBalance ?? 0)}</p>
            </div>
            <div className={`rounded-lg border p-3 ${border}`}>
              <p className={`text-xs flex items-center gap-1.5 ${subText}`}>
                {anchored ? 'Adjustment (posts)' : 'Adjustment (rollback ref.)'}
                <HelpTip
                  label={anchored ? 'Categorized total — what posts' : 'Rollback reference — not the categorized total'}
                  text={
                    anchored
                      ? 'FIFO target minus the QuickBooks balance, by category. This is the number the entry posts; the by-category table below is its detail. The backward-rollback reference valuation is not used for anchored months.'
                      : 'These three figures come from the backward-rollback valuation, the reference method: FIFO target minus the QB book balance. The number that actually posts is the Categorized total in the by-category table below, summed from the lot ledger — for non-anchored months the two differ substantially. A large adjustment either way is not one month of activity: the book balance carries years of accumulated estimates that were never tied to a valuation, so the first close catches up all of that drift in a single entry. The offset posts to Cost of Goods Sold.'
                  }
                />
              </p>
              <p className="text-lg font-bold tabular-nums" style={{ color: '#2563eb' }}>
                {usd.format(headline.adjustment ?? 0)}
              </p>
            </div>
          </div>

          <LargeAdjustmentNote
            darkMode={darkMode}
            fifoTarget={headline.fifoTarget}
            qbBookBalance={headline.qbBookBalance}
            adjustment={headline.adjustment}
            anchored={anchored}
          />

          {categoryJE && (
            <CategoryBreakdown
              key={categoryJE.location}
              je={categoryJE}
              categoryRollForward={categoryRollForward}
              categoryCogsSeries={categoryCogsSeries}
              firstAnchoredMonth={firstAnchoredMonth}
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
                      <td className="px-2 py-1">{formatAccount(l.accountName, accountNumbers)}</td>
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

          {header && (
            <div className="flex flex-wrap gap-2">
              {/* Always available, posted or not — the entry plus its source detail is what an
                  audit asks for, and asking for it must not depend on the entry being a draft. */}
              <JeSourceWorkbookLink headerId={header.id} docNumber={docNumber} darkMode={darkMode} />
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
  accountNumbers,
}: {
  cardBg: string;
  subText: string;
  border: string;
  views: LocationView[];
  basis: CloseBasis;
  month: string;
  monthEnd: string;
  accountNumbers: Record<string, Record<string, string>>;
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
                  <td className="px-2 py-1">{formatAccount(l.accountName, accountNumbers[l.location])}</td>
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
