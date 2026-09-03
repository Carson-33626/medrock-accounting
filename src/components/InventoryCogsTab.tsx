'use client';

import { useMemo } from 'react';
import DownloadIcon from './DownloadIcon';
import Explainer from './Explainer';
import HelpTip from './HelpTip';
import LabSuppliesAccrual from './LabSuppliesAccrual';
import { shortInventoryLocation } from '@/lib/inventory/monthly-close';
import { accountsForCategory } from '@/lib/inventory/category-accounts';
import { monthDates } from '@/lib/inventory/month-dates';
import {
  buildCogsRollForward,
  movementLocations,
  type CogsRollForward,
  type CogsRollForwardLine,
} from '@/lib/inventory/cogs-rollforward';
import type { CogsMonthFlag } from '@/lib/inventory/cogs-view';
import type { CategoryLedgerMovementRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface FlagCopy {
  badge: string;
  short: string;
  headline: string;
  body: string;
}

/**
 * The two months that are NOT operating cost of goods, spelled out for a reader
 * who has just landed on a number that looks wrong. The flag itself is decided
 * in `lib/inventory/cogs-view`; this is only how it reads on screen.
 */
const FLAG_COPY: Record<'cutover' | 'true-up', FlagCopy> = {
  cutover: {
    badge: '⚠ Cutover month — not operating COGS',
    short: 'cutover',
    headline: 'This is the one-time catch-up write-off, not a month of cost of goods.',
    body:
      'The first month anchored to a real count absorbs the write-off from every unanchored month before it, so years of unrecorded usage discharge here at once. It is excluded from Operating COGS and no month-end journal entry posts it as cost of goods.',
  },
  'true-up': {
    badge: '⚠ True-up month — not operating COGS',
    short: 'true-up',
    headline: 'A negative figure is inventory value being restored, not a credit to cost of goods.',
    body:
      'The current month is anchored lot-by-lot against the live lot report. Where that report shows more on hand than the simulation did, the anchor writes value back UP — which lands as negative consumption. It is excluded from Operating COGS; the month settles to a normal figure once it closes.',
  },
};

/** 'YYYY-MM' → 'March 2026'. */
function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** 'YYYY-MM' → 'Mar 2026', for a column header that has to stay narrow. */
function monthShort(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const money = (v: number | null): string => (v === null ? '—' : usd.format(v));

/**
 * Cost of goods sold, read straight off the FIFO lot ledger — for ONE month
 * against the month before it, by category, by location, tied to the QuickBooks
 * 5000.xx accounts.
 *
 * TWO MONTHS, NOT A YEAR. This tab used to be a category x month grid running
 * January to the selected month. That is the shape a P&L is read in and not the
 * shape this page is used in (Carson, 2026-09-03: "when i select march, shouldn't
 * the COGS breakdown show Feb & March to show where we started, and the COGS used
 * during the month... in reality this page will only ever need to look at two").
 * The month picker at the top of the page is still the only date control on the
 * tab — it now selects a month and its predecessor rather than a window.
 *
 * Built for Ash, who owns month-end allocation and the class/location splits.
 *
 * The arithmetic is `lib/inventory/cogs-rollforward`, which follows the month-end
 * close's own convention so the two cannot disagree — read that module's header
 * for why COGS and the shrink/anchor residual are shown as separate columns that
 * sum to the close's plug.
 */
export default function InventoryCogsTab({
  rows,
  firstAnchoredMonth,
  selectedMonth,
  location,
  loading,
  error,
  darkMode,
  cardBg,
  rowBorder,
  subText,
  exportBtnCls,
  exportBtnStyle,
}: {
  rows: CategoryLedgerMovementRow[];
  firstAnchoredMonth: string | null;
  selectedMonth: string | null;
  location: string;
  loading: boolean;
  error: string | null;
  darkMode: boolean;
  cardBg: string;
  rowBorder: string;
  subText: string;
  exportBtnCls: string;
  exportBtnStyle: { backgroundColor: string };
}) {
  const rf = useMemo(
    () =>
      selectedMonth === null
        ? null
        : buildCogsRollForward(rows, { location, firstAnchoredMonth, month: selectedMonth }),
    [rows, location, firstAnchoredMonth, selectedMonth],
  );

  const scopeLabel = location === 'all' ? 'All locations' : shortInventoryLocation(location);
  const flagCopy = rf && rf.flag ? FLAG_COPY[rf.flag] : null;
  const priorFlagCopy = rf && rf.priorFlag ? FLAG_COPY[rf.priorFlag] : null;
  /**
   * Before the anchor window. These months are ordinary COGS by this calculation —
   * not cutover, not true-up — but no close entry was ever posted for them, so the
   * figure ties to nothing in QuickBooks. Claiming it does would be worse than the
   * flags this tab already carries.
   */
  const preAnchor =
    rf !== null && firstAnchoredMonth !== null && rf.month < firstAnchoredMonth;
  /** Nothing in the ledger for either month on this scope. */
  const empty = rf === null || (rf.lines.length === 0 && rf.priorMonth === null);

  const exportHref = (format: 'csv' | 'xlsx'): string => {
    const params = new URLSearchParams({ location, format });
    if (selectedMonth) params.set('month', selectedMonth);
    return `/api/inventory/cogs?${params.toString()}`;
  };

  return (
    <>
      <Explainer id="inventory-cogs" title="What am I looking at?" openOnFirstVisit={false}>
        <p>
          <strong>Cost of goods sold, straight off the lot ledger.</strong> As stock is dispensed or
          used in compounding, the oldest lots go first (FIFO) and each unit is expensed at what that
          lot actually cost. Summed by location and QuickBooks category, that is this page.
        </p>
        <p>
          <strong>One month against the month before it.</strong> The month picker above selects the
          month; everything below shows where that month <em>started</em> (the prior month&rsquo;s
          closing inventory value), what was <em>purchased</em> into it, what <em>moved out</em>, and
          where it <em>ended</em>. Every row foots:{' '}
          <span className="font-semibold">beginning + purchases − what moved out = ending</span>.
        </p>
        <p>
          <strong>What moved out is split in two, because it posts to two accounts.</strong>{' '}
          <span className="font-semibold">COGS</span> is usage valued at the actual purchase price of
          the lots it came out of — the 5000.xx cost-of-goods lines, and the same basis the month-end
          close posts from. <span className="font-semibold">Shrink &amp; anchor</span> is the rest of
          the movement: stock written down to a real physical count, the current-month anchor writing
          value back up, and opening-balance lots that carry no unit cost. Shrink posts to{' '}
          <strong>5000.55 Drug Waste &amp; Shrinkage</strong> and is never commingled with operating
          COGS.
        </p>
        <p>
          <strong>Two months are not operating cost of goods</strong>, and both are labelled rather
          than quietly dropped. The <span className="font-semibold">cutover</span> month is the first
          month anchored to a real count: it carries the catch-up write-off from every unanchored
          month before it. A <span className="font-semibold">true-up</span> month is negative because
          the current-month lot anchor is restoring inventory value. When either the selected month
          or the comparison month is one of those, the month-over-month change is withheld — a
          percentage against a one-time discharge reads like information and is not.
        </p>
      </Explainer>

      {error && (
        <div className="rounded-lg bg-red-100 border border-red-300 text-red-800 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className={`rounded-xl shadow-sm p-6 text-sm ${cardBg} ${subText}`}>
          Loading cost of goods sold…
        </div>
      )}

      {!loading && !error && empty && (
        <div className={`rounded-xl shadow-sm p-6 text-sm ${cardBg} ${subText}`}>
          No lot-ledger movement for {scopeLabel} in {selectedMonth ? monthTitle(selectedMonth) : 'this month'}.
        </div>
      )}

      {!loading && !error && rf !== null && !empty && (
        <>
          {/* Headline — the selected month's COGS, then the roll-forward it sits
              inside, then the month before it. */}
          <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
            <p className={`text-sm ${subText}`}>
              Cost of goods sold in <strong>{monthTitle(rf.month)}</strong>
              {location === 'all' ? ', all locations' : `, ${scopeLabel}`}
            </p>
            <p className={`text-4xl md:text-5xl font-bold mt-2 ${flagCopy ? `line-through ${subText}` : ''}`}>
              {usd.format(rf.total.cogs)}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {flagCopy ? (
                <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
                  {flagCopy.badge}
                </span>
              ) : preAnchor ? (
                <span
                  title={`This month is before ${firstAnchoredMonth}, the first month anchored to a real count. It is simulation-only history: the lots were walked forward to reach a defensible opening, and no close entry was ever posted, so nothing in QuickBooks corresponds to this figure.`}
                  className="text-xs px-2 py-1 rounded border bg-slate-500/15 border-slate-400/40 font-semibold cursor-help"
                >
                  Simulation-only month — never posted
                </span>
              ) : (
                <span
                  title="Usage valued at the actual purchase price of the lots it came out of — the same figure the month-end close posts to the 5000.xx COGS accounts"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Ties to the month-end journal entry
                </span>
              )}
            </div>

            {flagCopy && (
              <div
                className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
                  darkMode
                    ? 'bg-amber-950/30 border-amber-800 text-amber-200'
                    : 'bg-amber-50 border-amber-300 text-amber-800'
                }`}
              >
                <span className="font-semibold">{flagCopy.headline}</span> {flagCopy.body}
              </div>
            )}

            {preAnchor && (
              <p className={`text-[11px] mt-3 ${subText}`}>
                {monthShort(rf.month)} falls before {firstAnchoredMonth}, the first month anchored to
                a real count — simulation-only history walked forward to reach a defensible opening.
                No close entry was ever posted for it, so this figure will not appear in QuickBooks.
              </p>
            )}

            {/* The roll-forward as four figures: where the month started, what
                came in, what went out, where it ended. */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              <RollForwardStat
                label={
                  rf.priorMonth === null
                    ? 'Beginning inventory'
                    : `Beginning — ${monthDates(rf.priorMonth).asOf}`
                }
                value={rf.total.beginning}
                subText={subText}
                note={
                  rf.priorMonth === null
                    ? 'No prior month in the ledger for this scope'
                    : `Closing value at ${monthShort(rf.priorMonth)}`
                }
              />
              <RollForwardStat
                label={`Purchases in ${monthShort(rf.month)}`}
                value={rf.total.purchases}
                subText={subText}
                note="Lots received in the month, at cost"
              />
              <RollForwardStat
                label={`COGS in ${monthShort(rf.month)}`}
                value={rf.total.cogs}
                subText={subText}
                note={
                  rf.total.adjustment === null || rf.total.adjustment === 0
                    ? 'Consumption at lot cost → 5000.xx'
                    : `+ ${usd.format(rf.total.adjustment)} shrink & anchor → 5000.55`
                }
                emphasis
              />
              <RollForwardStat
                label={`Ending — ${monthDates(rf.month).asOf}`}
                value={rf.total.ending}
                subText={subText}
                note={`Closing value at ${monthShort(rf.month)}`}
              />
            </div>

            {/* The comparison Carson asked for: is this month normal? */}
            <div className={`mt-5 pt-4 border-t text-sm ${rowBorder}`}>
              {rf.priorMonth === null ? (
                <span className={subText}>
                  No prior month to compare against — {monthShort(rf.month)} is the earliest month in
                  the ledger for {scopeLabel}.
                </span>
              ) : (
                <>
                  <span className={subText}>COGS in {monthTitle(rf.priorMonth)}: </span>
                  <span className={`font-semibold tabular-nums ${priorFlagCopy ? `line-through ${subText}` : ''}`}>
                    {usd.format(rf.total.priorCogs)}
                  </span>
                  {rf.delta === null ? (
                    <span className={`ml-2 ${subText}`}>
                      — month-over-month change withheld: the{' '}
                      {rf.flag !== null ? 'selected' : 'comparison'} month is a{' '}
                      {(rf.flag !== null ? flagCopy : priorFlagCopy)?.short} month, and a change
                      against it would not mean anything.
                    </span>
                  ) : (
                    <span
                      className={`ml-2 font-semibold tabular-nums ${
                        rf.delta.dollars === 0
                          ? subText
                          : rf.delta.dollars > 0
                            ? darkMode
                              ? 'text-amber-300'
                              : 'text-amber-700'
                            : darkMode
                              ? 'text-emerald-300'
                              : 'text-emerald-700'
                      }`}
                    >
                      {rf.delta.dollars >= 0 ? '+' : '−'}
                      {usd.format(Math.abs(rf.delta.dollars))}
                      {rf.delta.percent !== null && (
                        <span className="font-normal">
                          {' '}
                          ({rf.delta.percent >= 0 ? '+' : '−'}
                          {Math.abs(rf.delta.percent).toFixed(1)}%)
                        </span>
                      )}
                      <span className={`ml-1 font-normal ${subText}`}>
                        vs {monthShort(rf.priorMonth)}
                      </span>
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* The roll-forward by category — the QB account each line lands in. */}
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold flex items-center gap-1.5">
                Roll-forward by category — {scopeLabel}
                <HelpTip
                  label="How to read this table"
                  text="One row per QuickBooks COGS account. Beginning is the prior month's closing inventory value; purchases are the lots received in the selected month at cost; COGS is consumption valued at lot cost (the 5000.xx posting); shrink & anchor is the rest of the movement (write-downs to a physical count, the current-month anchor writing value back up, and opening-balance lots that carry no unit cost — 5000.55). Every row foots to Ending. With the location filter on 'All locations' the table aggregates FL, TN and TX; pick a location in the bar above to see one entity."
                />
              </p>
              <span className={`text-xs ${subText}`}>
                {rf.priorMonth === null
                  ? monthShort(rf.month)
                  : `${monthShort(rf.priorMonth)} → ${monthShort(rf.month)}`}
              </span>
              <div className="ml-auto flex gap-2">
                <a href={exportHref('csv')} className={exportBtnCls} style={exportBtnStyle}>
                  <DownloadIcon /> Export CSV
                </a>
                <a href={exportHref('xlsx')} className={exportBtnCls} style={exportBtnStyle}>
                  <DownloadIcon /> Export Excel
                </a>
              </div>
            </div>
            <RollForwardTable rf={rf} subText={subText} border={rowBorder} />
            {priorFlagCopy && (
              <p className={`text-[11px] mt-2 ${darkMode ? 'text-amber-300' : 'text-amber-700'}`}>
                Beginning comes from {monthShort(rf.priorMonth ?? '')}, a {priorFlagCopy.short}{' '}
                month — the closing value itself is sound, but that month&rsquo;s own COGS is not
                operating cost of goods.
              </p>
            )}
          </div>

          {/* COGS side by side, by category: which line actually moved. */}
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <p className="text-sm font-semibold">
              COGS by category —{' '}
              {rf.priorMonth === null
                ? monthShort(rf.month)
                : `${monthShort(rf.priorMonth)} vs ${monthShort(rf.month)}`}
            </p>
            <p className={`text-xs mt-1 ${subText}`}>
              Consumption at lot cost only, the 5000.xx basis — shrink and the anchor are excluded
              here, so this is what should tie to the QuickBooks P&amp;L line by line.
            </p>
            <CogsComparisonTable rf={rf} subText={subText} border={rowBorder} />
          </div>

          {/* By location, when the scope is company-wide — the class/location split
              is the cut Ash allocates on, and it is invisible in the aggregate. */}
          {location === 'all' && (
            <CogsByLocation
              rows={rows}
              firstAnchoredMonth={firstAnchoredMonth}
              month={rf.month}
              priorMonth={rf.priorMonth}
              cardBg={cardBg}
              rowBorder={rowBorder}
              subText={subText}
            />
          )}

          {/* Lab supplies are absent from every figure above — the category was
              cleared out of FIFO because it never reaches LifeFile. Its cost is
              accrued from QuickBooks instead, and it belongs on this tab so the
              COGS picture is not silently missing a line. */}
          <LabSuppliesAccrual
            cardBg={cardBg}
            rowBorder={rowBorder}
            subText={subText}
            darkMode={darkMode}
          />
        </>
      )}
    </>
  );
}

/** One figure of the headline roll-forward strip. */
function RollForwardStat({
  label,
  value,
  note,
  subText,
  emphasis = false,
}: {
  label: string;
  value: number | null;
  note: string;
  subText: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className={`text-xs ${subText}`}>{label}</p>
      <p className={`font-bold tabular-nums ${emphasis ? 'text-2xl' : 'text-xl'}`}>{money(value)}</p>
      <p className={`text-[11px] mt-0.5 ${subText}`}>{note}</p>
    </div>
  );
}

function RollForwardTable({
  rf,
  subText,
  border,
}: {
  rf: CogsRollForward;
  subText: string;
  border: string;
}) {
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const cell = 'px-2 py-1.5 text-right tabular-nums';
  const beginningHeader =
    rf.priorMonth === null ? 'Beginning' : `Beginning ${monthDates(rf.priorMonth).asOf}`;

  const line = (l: CogsRollForwardLine, key: string, footer: boolean) => {
    const { cogs: account, mapped } = accountsForCategory(l.qbCategory);
    return (
      <tr
        key={key}
        className={footer ? `border-t-2 font-semibold ${border}` : `border-b last:border-0 ${border}`}
      >
        <td className="px-2 py-1.5 font-medium">{l.qbCategory}</td>
        <td className={`px-2 py-1.5 text-xs ${mapped && !footer ? '' : subText}`}>
          {footer ? 'Cost of Goods Sold (5000.xx)' : account}
          {!footer && !mapped && (
            <span
              title="No dedicated QuickBooks account — this bucket posts to the parent Cost of Goods Sold line as a residual."
              className="ml-1 text-[9px] px-1 rounded bg-slate-500/20 font-semibold uppercase cursor-help"
            >
              residual
            </span>
          )}
        </td>
        <td className={`${cell} ${subText}`}>{money(l.beginning)}</td>
        <td className={`${cell} ${subText}`}>{money(l.purchases)}</td>
        <td className={cell}>{money(l.cogs)}</td>
        <td className={`${cell} ${subText}`}>{money(l.adjustment)}</td>
        <td className={cell}>{money(l.ending)}</td>
      </tr>
    );
  };

  return (
    <div className="overflow-x-auto mt-3">
      <table className="w-full text-sm">
        <thead>
          <tr className={`border-b ${border}`}>
            <th className={th}>Category</th>
            <th className={th}>QuickBooks COGS account</th>
            <th className={`${th} text-right`} title="The prior month's closing inventory value">
              {beginningHeader}
            </th>
            <th className={`${th} text-right`} title="Lots received in the month, at cost">
              Purchases
            </th>
            <th className={`${th} text-right`} title="Consumption valued at lot cost — posts to 5000.xx">
              COGS
            </th>
            <th
              className={`${th} text-right`}
              title="The rest of the movement: write-downs to a physical count and the current-month anchor writing value back up (5000.55), plus opening-balance lots that carry no unit cost"
            >
              Shrink &amp; anchor
            </th>
            <th className={`${th} text-right`} title="Closing inventory value at the selected month end">
              Ending {monthDates(rf.month).asOf}
            </th>
          </tr>
        </thead>
        <tbody>{rf.lines.map((l) => line(l, l.qbCategory, false))}</tbody>
        <tfoot>{line(rf.total, 'total', true)}</tfoot>
      </table>
    </div>
  );
}

function CogsComparisonTable({
  rf,
  subText,
  border,
}: {
  rf: CogsRollForward;
  subText: string;
  border: string;
}) {
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const cell = 'px-2 py-1.5 text-right tabular-nums';
  /** The category-grain delta is withheld on exactly the months the total's is —
   *  the flag is a property of the month, not of the line. */
  const comparable = rf.delta !== null;

  /**
   * A category that moved nothing in EITHER month is not a line of this report.
   * `Uncoded` and `Opening Balance` are the usual pair: both are real categories
   * that hold inventory value, but neither consumes at a cost basis, so they sit
   * at $0.00 / $0.00 / — and push the lines that did move further down the table.
   *
   * Dropped on the figures, never on the category name: a month where Uncoded
   * genuinely consumes still shows it. And this filter is deliberately NOT
   * applied to the roll-forward table above, where the same categories carry real
   * beginning and ending BALANCES — zero COGS there is a fact about the movement
   * column, not a reason to hide the stock.
   */
  const shown = rf.lines.filter((l) => l.cogs !== 0 || l.priorCogs !== 0);
  const hidden = rf.lines.length - shown.length;

  const line = (l: CogsRollForwardLine, key: string, footer: boolean) => {
    const change = l.cogs - l.priorCogs;
    const percent = l.priorCogs === 0 ? null : (change / Math.abs(l.priorCogs)) * 100;
    return (
      <tr
        key={key}
        className={footer ? `border-t-2 font-semibold ${border}` : `border-b last:border-0 ${border}`}
      >
        <td className="px-2 py-1.5 font-medium">{l.qbCategory}</td>
        <td className={`${cell} ${rf.priorFlag !== null ? `line-through ${subText}` : subText}`}>
          {rf.priorMonth === null ? '—' : usd.format(l.priorCogs)}
        </td>
        <td className={`${cell} ${rf.flag !== null ? `line-through ${subText}` : ''}`}>
          {usd.format(l.cogs)}
        </td>
        <td className={cell}>{comparable ? usd.format(change) : '—'}</td>
        <td className={`${cell} ${subText}`}>
          {comparable && percent !== null ? `${percent >= 0 ? '+' : '−'}${Math.abs(percent).toFixed(1)}%` : '—'}
        </td>
      </tr>
    );
  };

  return (
    <div className="overflow-x-auto mt-3">
      <table className="w-full text-sm">
        <thead>
          <tr className={`border-b ${border}`}>
            <th className={th}>Category</th>
            <th className={`${th} text-right`}>
              {rf.priorMonth === null ? 'Prior month' : monthShort(rf.priorMonth)}
            </th>
            <th className={`${th} text-right`}>{monthShort(rf.month)}</th>
            <th className={`${th} text-right`}>Change</th>
            <th className={`${th} text-right`}>%</th>
          </tr>
        </thead>
        <tbody>{shown.map((l) => line(l, l.qbCategory, false))}</tbody>
        <tfoot>{line(rf.total, 'total', true)}</tfoot>
      </table>
      {hidden > 0 && (
        <p className={`text-[11px] mt-2 ${subText}`}>
          {hidden} categor{hidden === 1 ? 'y is' : 'ies are'} hidden: nothing consumed in either
          month. They still hold inventory value on the roll-forward above.
        </p>
      )}
      {!comparable && (
        <p className={`text-[11px] mt-2 ${subText}`}>
          {rf.priorMonth === null
            ? 'No prior month in the ledger for this scope, so there is nothing to compare against.'
            : 'The change is withheld: one of these two months is a cutover or true-up month and is not operating cost of goods.'}
        </p>
      )}
    </div>
  );
}

/**
 * The same two months, cut by location. Each location is flagged on its own
 * months: a location can be truing value up in a month the company total is
 * positive, and rolling that into one figure would hide it.
 */
function CogsByLocation({
  rows,
  firstAnchoredMonth,
  month,
  priorMonth,
  cardBg,
  rowBorder,
  subText,
}: {
  rows: CategoryLedgerMovementRow[];
  firstAnchoredMonth: string | null;
  month: string;
  priorMonth: string | null;
  cardBg: string;
  rowBorder: string;
  subText: string;
}) {
  const locations = movementLocations(rows, [month, priorMonth]);
  const perLocation = locations.map((loc) => ({
    location: loc,
    rf: buildCogsRollForward(rows, { location: loc, firstAnchoredMonth, month }),
  }));
  if (perLocation.length < 2) return null;

  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const cell = 'px-2 py-1.5 text-right tabular-nums';

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">By location</p>
      <p className={`text-xs mt-1 ${subText}`}>
        Each location&rsquo;s own months are flagged separately — one entity can be truing value up
        in a month the company total is positive. This is the class/location split month-end
        allocation runs on.
      </p>
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${subText} ${rowBorder}`}>
              <th className={th}>Location</th>
              <th className={`${th} text-right`}>Beginning</th>
              <th className={`${th} text-right`}>Purchases</th>
              <th className={`${th} text-right`}>COGS</th>
              <th className={`${th} text-right`}>Shrink &amp; anchor</th>
              <th className={`${th} text-right`}>Ending</th>
              <th className={`${th} text-right`}>
                {priorMonth === null ? 'Prior month' : `COGS ${monthShort(priorMonth)}`}
              </th>
              <th className={`${th} text-right`}>Change</th>
            </tr>
          </thead>
          <tbody>
            {perLocation.map(({ location: loc, rf }) => (
              <tr key={loc} className={`border-b last:border-0 ${rowBorder}`}>
                <td className="px-2 py-1.5 font-medium">
                  {shortInventoryLocation(loc)}
                  <LocationFlagBadge flag={rf.flag} />
                </td>
                <td className={`${cell} ${subText}`}>{money(rf.total.beginning)}</td>
                <td className={`${cell} ${subText}`}>{money(rf.total.purchases)}</td>
                <td className={`${cell} ${rf.flag !== null ? `line-through ${subText}` : ''}`}>
                  {usd.format(rf.total.cogs)}
                </td>
                <td className={`${cell} ${subText}`}>{money(rf.total.adjustment)}</td>
                <td className={cell}>{usd.format(rf.total.ending)}</td>
                <td className={`${cell} ${rf.priorFlag !== null ? `line-through ${subText}` : subText}`}>
                  {rf.priorMonth === null ? '—' : usd.format(rf.total.priorCogs)}
                </td>
                <td className={cell}>{rf.delta === null ? '—' : usd.format(rf.delta.dollars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LocationFlagBadge({ flag }: { flag: CogsMonthFlag }) {
  if (flag === null) return null;
  const copy = FLAG_COPY[flag];
  return (
    <span
      title={`${copy.headline} ${copy.body}`}
      className="ml-1.5 text-[9px] px-1 rounded bg-amber-500/20 text-amber-600 font-semibold uppercase cursor-help"
    >
      {copy.short}
    </span>
  );
}
