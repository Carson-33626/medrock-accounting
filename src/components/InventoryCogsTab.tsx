'use client';

import { useMemo, useState } from 'react';
import CategoryCogsByMonth from './CategoryCogsByMonth';
import DownloadIcon from './DownloadIcon';
import Explainer from './Explainer';
import HelpTip from './HelpTip';
import LabSuppliesAccrual from './LabSuppliesAccrual';
import { shortInventoryLocation } from '@/lib/inventory/monthly-close';
import {
  buildCogsGrid,
  isExcludedMonth,
  monthFlag,
  monthTotal,
  operatingMonths,
  operatingTotal,
  type CogsMonthFlag,
} from '@/lib/inventory/cogs-view';
import type { CategoryCogsSeriesRow } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** How much of the history the tab shows: the selected month's year so far, or
 *  everything. Year-to-date is the default — it is the window an accountant
 *  reconciles a P&L over, and it keeps the grid narrow enough to read. */
type CogsRange = 'ytd' | 'all';

interface FlagCopy {
  badge: string;
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
    headline: 'This is the one-time catch-up write-off, not a month of cost of goods.',
    body:
      'The first month anchored to a real count absorbs the write-off from every unanchored month before it, so years of unrecorded usage discharge here at once. It is excluded from Operating COGS and no month-end journal entry posts it as cost of goods.',
  },
  'true-up': {
    badge: '⚠ True-up month — not operating COGS',
    headline: 'A negative figure is inventory value being restored, not a credit to cost of goods.',
    body:
      'The current month is anchored lot-by-lot against the live lot report. Where that report shows more on hand than the simulation did, the anchor writes value back UP — which lands as negative consumption. It is excluded from Operating COGS; the month settles to a normal figure once it closes.',
  },
};

/**
 * Cost of goods sold, read straight off the FIFO lot ledger — by category, by
 * month, by location, tied to the QuickBooks 5000.xx accounts.
 *
 * Built for Ash, who owns month-end allocation and the class/location splits and
 * until now could not see COGS on this page at all.
 *
 * Every figure here is `qty_consumed x unit_cost` from the lot ledger — the same
 * basis the month-end close posts from, so a number on this tab and the same cell
 * on the close are the same number by construction, not by coincidence.
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
  rows: CategoryCogsSeriesRow[];
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
  const [range, setRange] = useState<CogsRange>('ytd');

  /** The window the grid, the totals and the exports all share. Year-to-date is
   *  January of the selected month's year through the selected month. */
  const monthWindow = useMemo(() => {
    if (range === 'all' || !selectedMonth) return { from: undefined, to: undefined };
    return { from: `${selectedMonth.slice(0, 4)}-01`, to: selectedMonth };
  }, [range, selectedMonth]);

  const windowRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          (monthWindow.from === undefined || r.month >= monthWindow.from) &&
          (monthWindow.to === undefined || r.month <= monthWindow.to),
      ),
    [rows, monthWindow],
  );

  const grid = useMemo(
    () => buildCogsGrid(rows, { location, firstAnchoredMonth, fromMonth: monthWindow.from, toMonth: monthWindow.to }),
    [rows, location, firstAnchoredMonth, monthWindow],
  );

  const scopeLabel = location === 'all' ? 'All locations' : shortInventoryLocation(location);
  const monthFigure = selectedMonth ? monthTotal(grid, selectedMonth) : 0;
  const monthInWindow = selectedMonth !== null && grid.months.includes(selectedMonth);
  const flag: CogsMonthFlag = selectedMonth ? monthFlag(grid, selectedMonth) : null;
  const flagCopy = flag ? FLAG_COPY[flag] : null;

  const operating = operatingTotal(grid);
  const operatingCount = operatingMonths(grid).length;
  const operatingAverage = operatingCount > 0 ? operating / operatingCount : 0;
  /** True once the window opens before the anchor window — months that are real
   *  COGS by this calculation but were never posted to QuickBooks. */
  const includesPreAnchor =
    firstAnchoredMonth !== null && grid.months.length > 0 && grid.months[0] < firstAnchoredMonth;

  const exportHref = (format: 'csv' | 'xlsx'): string => {
    const params = new URLSearchParams({ location, format });
    if (monthWindow.from) params.set('from', monthWindow.from);
    if (monthWindow.to) params.set('to', monthWindow.to);
    return `/api/inventory/cogs?${params.toString()}`;
  };

  const rangeBtn = (value: CogsRange, label: string) => (
    <button
      onClick={() => setRange(value)}
      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
        range === value ? 'text-white' : darkMode ? 'text-slate-300' : 'text-slate-600'
      }`}
      style={range === value ? exportBtnStyle : undefined}
    >
      {label}
    </button>
  );

  return (
    <>
      <Explainer id="inventory-cogs" title="What am I looking at?">
        <p>
          <strong>Cost of goods sold, straight off the lot ledger.</strong> As stock is dispensed or
          used in compounding, the oldest lots go first (FIFO) and each unit is expensed at what that
          lot actually cost. Summed by month, location and QuickBooks category, that is this page.
        </p>
        <p>
          This is the <strong>same basis the month-end close posts from</strong> — usage valued at
          receipt price — so a figure here and the corresponding line on the close are the same
          number. Each row shows the <strong>5000.xx account</strong> it lands in, so a month can be
          tied straight to the QuickBooks P&amp;L.
        </p>
        <p>
          <strong>Two months are not operating cost of goods</strong>, and both are shown struck
          through and held out of every total rather than quietly dropped. The{' '}
          <span className="font-semibold">cutover</span> month is the first month anchored to a real
          count: it carries the catch-up write-off from every unanchored month before it. A{' '}
          <span className="font-semibold">true-up</span> month is negative because the current-month
          lot anchor is restoring inventory value, not crediting cost of goods.
        </p>
        <p>
          Waste and shrink are <em>not</em> in these figures. They post to the dedicated{' '}
          <strong>5000.55 Drug Waste &amp; Shrinkage</strong> line and are never commingled with
          operating COGS — see <strong>This month&rsquo;s movement</strong> on the Valuation tab.
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

      {!loading && !error && grid.months.length === 0 && (
        <div className={`rounded-xl shadow-sm p-6 text-sm ${cardBg} ${subText}`}>
          No cost of goods sold for {scopeLabel} in this window.
        </div>
      )}

      {!loading && !error && grid.months.length > 0 && (
        <>
          {/* Headline — the selected month, on the current location scope. */}
          <div className={`rounded-2xl shadow-sm p-6 md:p-8 ${cardBg}`}>
            <p className={`text-sm ${subText}`}>
              Cost of goods sold in <strong>{selectedMonth ?? '—'}</strong>
              {location === 'all' ? ', all locations' : `, ${scopeLabel}`}
            </p>
            <p className={`text-4xl md:text-5xl font-bold mt-2 ${flag ? `line-through ${subText}` : ''}`}>
              {monthInWindow ? usd.format(monthFigure) : '—'}
            </p>
            {/* No badge at all for a month with no COGS in the window: claiming a
                dash ties to a journal entry would be worse than saying nothing. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {flagCopy && (
                <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
                  {flagCopy.badge}
                </span>
              )}
              {monthInWindow && !flagCopy && (
                <span
                  title="Usage valued at the actual purchase price of the lots it came out of — the same figure the month-end close posts to the 5000.xx COGS accounts"
                  className="text-xs px-2 py-1 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold cursor-help"
                >
                  ✓ Ties to the month-end journal entry
                </span>
              )}
              {!monthInWindow && (
                <span className={`text-xs ${subText}`}>
                  No cost of goods sold for {selectedMonth ?? 'this month'} in this window
                  {range === 'ytd' ? ' — try All months.' : '.'}
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
                {operatingCount > 0 && (
                  <>
                    {' '}
                    A normal month on this scope runs {usd.format(operatingAverage)}.
                  </>
                )}
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className={`text-xs ${subText}`}>
                  Operating COGS, {range === 'ytd' ? 'year to date' : 'all months'}
                </p>
                <p className="text-xl font-bold tabular-nums">{usd.format(operating)}</p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Operating months counted</p>
                <p className="text-xl font-bold tabular-nums">
                  {operatingCount}
                  <span className={`text-xs font-normal ml-1 ${subText}`}>
                    of {grid.months.length}
                  </span>
                </p>
              </div>
              <div>
                <p className={`text-xs ${subText}`}>Average operating month</p>
                <p className="text-xl font-bold tabular-nums">{usd.format(operatingAverage)}</p>
              </div>
            </div>
            <p className={`text-xs mt-4 ${subText}`}>
              Operating COGS excludes the cutover and true-up months — {grid.months.length - operatingCount}{' '}
              of the {grid.months.length} months in this window.
            </p>
          </div>

          {/* The grid: by category, by month, with the QB account each lands in. */}
          <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold flex items-center gap-1.5">
                COGS by category — {scopeLabel}
                <HelpTip
                  label="How to read this grid"
                  text="One row per QuickBooks COGS account, one column per month. The Operating total column sums only the months that are operating cost of goods; the cutover and true-up months are shown struck through so nothing disappears without explanation. With the location filter on 'All locations' the grid aggregates FL, TN and TX; pick a location in the bar above to see one entity."
                />
              </p>
              <div className={`inline-flex rounded-lg border overflow-hidden ${rowBorder}`}>
                {rangeBtn('ytd', 'Year to date')}
                {rangeBtn('all', 'All months')}
              </div>
              <div className="ml-auto flex gap-2">
                <a href={exportHref('csv')} className={exportBtnCls} style={exportBtnStyle}>
                  <DownloadIcon /> Export CSV
                </a>
                <a href={exportHref('xlsx')} className={exportBtnCls} style={exportBtnStyle}>
                  <DownloadIcon /> Export Excel
                </a>
              </div>
            </div>
            <CategoryCogsByMonth
              rows={windowRows}
              location={location}
              firstAnchoredMonth={firstAnchoredMonth}
              darkMode={darkMode}
              subText={subText}
              border={rowBorder}
              variant="full"
            />
            {/* Only the cutover and true-up months are held out of the operating
                total. Months BEFORE the anchor window are ordinary COGS by this
                calculation, but no close entry was ever posted for them — so the
                operating total over a window that reaches back there is our
                figure, not something that reconciles to a QuickBooks balance. */}
            {includesPreAnchor && (
              <p className={`text-[11px] mt-2 ${subText}`}>
                This window reaches back before {firstAnchoredMonth}, the first month anchored to a
                real count. Those earlier months are simulation-only history — no close entry was
                ever posted for them, so they will not appear in QuickBooks even though they count
                toward the operating total here.
              </p>
            )}
          </div>

          {/* By location, when the scope is company-wide — the class/location split
              is the cut Ash allocates on, and it is invisible in the aggregate grid. */}
          {location === 'all' && (
            <CogsByLocation
              rows={windowRows}
              firstAnchoredMonth={firstAnchoredMonth}
              monthWindow={monthWindow}
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

/**
 * The same operating total, cut by location. Each location is flagged on its own
 * months: a location can be truing up in a month the company total is positive,
 * and rolling that into one figure would hide it.
 */
function CogsByLocation({
  rows,
  firstAnchoredMonth,
  monthWindow,
  cardBg,
  rowBorder,
  subText,
}: {
  rows: CategoryCogsSeriesRow[];
  firstAnchoredMonth: string | null;
  monthWindow: { from: string | undefined; to: string | undefined };
  cardBg: string;
  rowBorder: string;
  subText: string;
}) {
  const locations = [...new Set(rows.map((r) => r.location))].sort();
  if (locations.length < 2) return null;

  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <p className="text-sm font-semibold">Operating COGS by location</p>
      <p className={`text-xs mt-1 ${subText}`}>
        Each location&rsquo;s own months are flagged separately — one entity can be truing value up
        in a month the company total is positive.
      </p>
      <table className="w-full text-sm mt-3">
        <thead>
          <tr className={`border-b ${subText} ${rowBorder}`}>
            <th className="px-2 py-1 text-left font-medium">Location</th>
            <th className="px-2 py-1 text-right font-medium">Operating COGS</th>
            <th className="px-2 py-1 text-right font-medium">Operating months</th>
            <th className="px-2 py-1 text-right font-medium">Excluded months</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((loc) => {
            const g = buildCogsGrid(rows, {
              location: loc,
              firstAnchoredMonth,
              fromMonth: monthWindow.from,
              toMonth: monthWindow.to,
            });
            const excluded = g.months.filter((m) => isExcludedMonth(g, m));
            return (
              <tr key={loc} className={`border-b last:border-0 ${rowBorder}`}>
                <td className="px-2 py-1.5 font-medium">{shortInventoryLocation(loc)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{usd.format(operatingTotal(g))}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{operatingMonths(g).length}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${subText}`}>
                  {excluded.length === 0 ? '—' : excluded.join(', ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
