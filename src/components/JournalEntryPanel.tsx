'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import HelpTip from './HelpTip';
import type { CloseBasis, LocationJE } from '@/types/inventory';
import { journalEntryLines } from '@/lib/inventory/monthly-close';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 'MedRock Florida' → 'FL' — mirrors the End of Month tab's SHORT_ENT labels. */
function shortLocation(location: string): string {
  const name = location.replace('MedRock ', '');
  if (name === 'Florida') return 'FL';
  if (name === 'Tennessee') return 'TN';
  if (name === 'Texas') return 'TX';
  return name;
}

/** 'FL Inv Adj 2026.07' — display-only draft doc number, styled after 'FL % Allo 2026.06'. */
function draftDocNumber(location: string, month: string): string {
  return `${shortLocation(location)} Inv Adj ${month.replace('-', '.')}`;
}

/**
 * Suggested adjusting JE per location: FIFO target (selected basis Ending) vs.
 * the QB inventory-asset book balance. Presented in the End of Month tab's
 * draft-card style — sub-tab per location + Combined — because that is the JE
 * layout accounting reviews everywhere else. Review-only: nothing posts to QB.
 */
export default function JournalEntryPanel({
  journalEntries,
  basis,
  monthEnd,
  month,
  darkMode,
}: {
  journalEntries: LocationJE[];
  basis: CloseBasis;
  monthEnd: string;
  month: string;
  darkMode: boolean;
}) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  const [tab, setTab] = useState<string>('first');
  const activeLocation = tab === 'first' ? (journalEntries[0]?.location ?? 'combined') : tab;
  const activeJe = journalEntries.find((je) => je.location === activeLocation) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          Suggested adjusting journal entry
          <HelpTip
            label="What this entry does"
            text="Books the difference between the FIFO ending value and the QuickBooks inventory-asset book balance, per location. It restates the inventory asset to the FIFO figure — review it with the CPA and post manually; this page never writes to QuickBooks."
          />
        </p>
        <span className="text-xs px-2 py-1 rounded border bg-amber-50 text-amber-800 border-amber-200 font-semibold">
          Suggested only — nothing is posted to QuickBooks
        </span>
      </div>

      {/* Sub-tab bar — one tab per location + Combined (mirrors the End of Month drafts). */}
      <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
        {journalEntries.map((je) => (
          <button
            key={je.location}
            onClick={() => setTab(je.location)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
              activeLocation === je.location
                ? 'bg-blue-600 text-white'
                : darkMode
                  ? 'text-slate-300 hover:bg-slate-700'
                  : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {shortLocation(je.location)} · {je.bookAvailable ? 'Suggested' : 'No QB link'}
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

      {activeJe ? (
        <SuggestedDraftCard
          darkMode={darkMode}
          cardBg={cardBg}
          subText={subText}
          border={border}
          je={activeJe}
          basis={basis}
          month={month}
          monthEnd={monthEnd}
        />
      ) : (
        <CombinedCard
          cardBg={cardBg}
          subText={subText}
          border={border}
          journalEntries={journalEntries}
          basis={basis}
          month={month}
          monthEnd={monthEnd}
        />
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

function SuggestedDraftCard({
  darkMode,
  cardBg,
  subText,
  border,
  je,
  basis,
  month,
  monthEnd,
}: {
  darkMode: boolean;
  cardBg: string;
  subText: string;
  border: string;
  je: LocationJE;
  basis: CloseBasis;
  month: string;
  monthEnd: string;
}) {
  const th = `px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider ${subText}`;
  const lines = useMemo(() => journalEntryLines(je, basis, monthEnd), [je, basis, monthEnd]);
  const debitTotal = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const creditTotal = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0));

  if (!je.bookAvailable) {
    return (
      <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-3`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{je.location}</p>
            <p className={`text-xs ${subText}`}>
              {draftDocNumber(je.location, month)} · {monthEnd}
            </p>
          </div>
          <StatusBadge darkMode={darkMode} label="Book balance unavailable" />
        </div>
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
      </div>
    );
  }

  return (
    <div className={`rounded-xl shadow-sm ${cardBg} border ${border} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{je.location}</p>
          <p className={`text-xs ${subText}`}>
            {draftDocNumber(je.location, month)} · {monthEnd}
          </p>
        </div>
        <StatusBadge darkMode={darkMode} label="Suggested" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-lg border p-3 ${border}`}>
          <p className={`text-xs ${subText}`}>FIFO target</p>
          <p className="text-lg font-bold tabular-nums">{usd.format(je.fifoTarget)}</p>
        </div>
        <div className={`rounded-lg border p-3 ${border}`}>
          <p className={`text-xs ${subText}`}>QB book balance</p>
          <p className="text-lg font-bold tabular-nums">{usd.format(je.qbBookBalance ?? 0)}</p>
        </div>
        <div className={`rounded-lg border p-3 ${border}`}>
          <p className={`text-xs ${subText}`}>Adjustment</p>
          <p className="text-lg font-bold tabular-nums" style={{ color: '#2563eb' }}>
            {usd.format(je.adjustment ?? 0)}
          </p>
        </div>
      </div>

      {lines.length === 0 ? (
        <p className={`text-sm ${subText}`}>No adjustment needed — FIFO ties to the book balance.</p>
      ) : (
        <>
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
                  <tr key={`${l.account}-${i}`} className={`border-b last:border-0 ${border}`}>
                    <td className={`px-2 py-1 text-xs ${subText}`}>{l.debit !== null ? 'Debit' : 'Credit'}</td>
                    <td className="px-2 py-1">{l.account}</td>
                    <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.debit !== null ? usd.format(l.debit) : ''}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.credit !== null ? usd.format(l.credit) : ''}</td>
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
        </>
      )}
    </div>
  );
}

/** Read-only merged view of every location's suggested lines (mirrors the End of
 *  Month Combined grid): each line with its entity, one totals row. */
function CombinedCard({
  cardBg,
  subText,
  border,
  journalEntries,
  basis,
  month,
  monthEnd,
}: {
  cardBg: string;
  subText: string;
  border: string;
  journalEntries: LocationJE[];
  basis: CloseBasis;
  month: string;
  monthEnd: string;
}) {
  const rows = journalEntries.flatMap((je) =>
    journalEntryLines(je, basis, monthEnd).map((l, i) => ({
      ...l,
      location: je.location,
      _key: `${je.location}-${i}`,
    })),
  );
  const debitTotal = round2(rows.reduce((s, l) => s + (l.debit ?? 0), 0));
  const creditTotal = round2(rows.reduce((s, l) => s + (l.credit ?? 0), 0));

  return (
    <div className={`rounded-xl shadow-sm ${cardBg}`}>
      <div className={`px-4 py-3 border-b ${border} flex items-center justify-between`}>
        <p className="text-sm font-semibold">Combined — all locations, {month}</p>
        <p className={`text-xs ${subText}`}>read-only · per-location detail on each tab</p>
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
                  <td className={`px-2 py-1 text-xs whitespace-nowrap ${subText}`}>{shortLocation(l.location)}</td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.debit !== null ? 'Debit' : 'Credit'}</td>
                  <td className="px-2 py-1">{l.account}</td>
                  <td className={`px-2 py-1 text-xs ${subText}`}>{l.memo}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.debit !== null ? usd.format(l.debit) : ''}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.credit !== null ? usd.format(l.credit) : ''}</td>
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
