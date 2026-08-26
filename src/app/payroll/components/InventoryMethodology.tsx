'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, Loader2 } from 'lucide-react';
import type {
  MethodResponse,
  MethodStatementRow,
} from '@/app/api/inventory/monthly-close/method/route';

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Plain-English definitions for the terms this page (and the close JEs) use. */
const GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  [
    'FIFO (first-in, first-out)',
    'The costing rule: when stock is consumed, it always comes out of the OLDEST purchase still on hand, at the price we actually paid for that purchase. Nothing is valued at an average or an estimate.',
  ],
  [
    'Lot',
    'One purchase receipt of one product — its quantity, its invoice cost, its date. The ledger is ~15,300 of these; every dollar on this page traces back to specific lots.',
  ],
  [
    'Roll-forward',
    'The monthly statement identity: Beginning + Purchases − COGS − Waste − Shrink = Ending. Each month’s ending is the next month’s beginning; every table here foots to it exactly.',
  ],
  [
    'COGS (usage-driven)',
    'Cost of the stock consumed by recorded activity — dispensing and compounding usage the pharmacy system logged — valued at the FIFO lot costs. Posts to each category’s own COGS account.',
  ],
  [
    'Waste (documented disposal)',
    'Stock the pharmacy system explicitly recorded as removed: expirations, destruction, spillage, count corrections — each entry dated, lot-level, and attributed to the staff member who logged it. Written off on the date it happened.',
  ],
  [
    'Shrink (count residual)',
    'The gap that remains after usage and documented waste: stock the roll-forward says we should hold but the month-end count says we don’t. Consumption that never generated a record — compounding loss, breakage, unlogged disposal. Measured monthly, never estimated.',
  ],
  [
    'The count (Balance On Hand)',
    'The pharmacy system’s statement of what is on the shelf as of a date, per product per pharmacy. It is the system’s recorded position, not a physical hand count — a retroactive pull reproduces the independently-stored copy of the same month at 98.2%.',
  ],
  [
    'Anchoring / count-anchored month',
    'Forcing a month’s ending balance to match its real count instead of trusting our simulation. Each of the last nine month-ends is pinned to its own count; the difference becomes that month’s shrink. The current, unfinished month is anchored to the live lot report instead ("lot-anchored").',
  ],
  [
    'Write-down only',
    'Anchoring only ever reduces the ledger. A count ABOVE the roll-forward is investigated, never booked as found inventory — the books can be conservative but never optimistic.',
  ],
  [
    'Settled stop point / postable window',
    'February 2026 and earlier are final — no entries are ever posted there. March 2026 forward is the postable window this method states. Older history exists only to walk the lots forward to a defensible opening.',
  ],
  [
    'Opening correction',
    'The one-time entry dated 2026-03-01 that moves each inventory sub-account from its old estimated balance to the FIFO opening. Posts once, to its own offset account, and is never repeated.',
  ],
  [
    'Backward reconstruction (the control)',
    'A second, independent valuation that works BACKWARD from today’s counted position instead of forward from receipts. It shares none of the forward method’s steps, so the two agreeing (the ratio column above) is evidence the method found the real number.',
  ],
  [
    'Residual / Uncoded',
    'Purchases not yet assigned to a drug category. They are valued like everything else but post as one combined line on the parent accounts until they get coded.',
  ],
  [
    'Pre-conversion bucket (Florida)',
    'Florida compounded on a different system (Pioneer) until early 2025, so its LifeFile usage history starts late. The $2.45M of earlier Florida purchases is excluded as a flagged, auditable bucket — corroborated by Pioneer’s own records showing the stock was consumed.',
  ],
  [
    'Draft / Approved / Posted / Dry run',
    'The workflow on the Close JEs tab: Generate freezes the numbers into a Draft; an accountant Approves it; a Dry run shows exactly what QuickBooks would receive without sending it; Post live writes the entry. Nothing reaches QuickBooks without an explicit approve and post.',
  ],
];

/**
 * Methodology & Evidence — the shareable "how, where, and what" behind the
 * inventory close numbers, with the live figures pulled from the same tables
 * the JEs generate from. Companion documents:
 * docs/fifo-monthly-close/close-package-method-note.md (CPA method note) and
 * 2026-08-26-correction-je-proposal.md (the opening correction).
 */
export function InventoryMethodology({ darkMode }: { darkMode: boolean }) {
  const [data, setData] = useState<MethodResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/monthly-close/method')
      .then((r) => r.json() as Promise<MethodResponse | { error: string }>)
      .then((body) => {
        if (cancelled) return;
        if ('error' in body) setError(body.error);
        else setData(body);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load figures');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const stepBg = darkMode ? 'bg-slate-700/60' : 'bg-slate-50';
  const badge = darkMode ? 'bg-indigo-900/60 text-indigo-200' : 'bg-indigo-100 text-indigo-800';
  const thCls = `text-left font-medium py-1 pr-3 ${subText}`;
  const numTh = `text-right font-medium py-1 pr-3 ${subText}`;
  const numCls = 'py-1 pr-3 text-right tabular-nums';

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className={`rounded-xl shadow-sm ${cardBg} p-4 space-y-3`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );

  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <div className={`rounded-lg ${stepBg} p-3`}>
      <p className="text-sm font-medium">
        <span className={`inline-block w-5 h-5 text-center rounded-full text-xs font-bold mr-2 ${badge}`}>{n}</span>
        {title}
      </p>
      <p className={`text-sm mt-1 ${subText}`}>{children}</p>
    </div>
  );

  const statementFooter = (rows: MethodStatementRow[]): string => {
    const shrinks = rows.filter((r) => !r.inProgress).map((r) => r.shrink);
    if (shrinks.length === 0) return '';
    const lo = Math.min(...shrinks);
    const hi = Math.max(...shrinks);
    return `Shrink runs ${usd(lo)}–${usd(hi)} per completed month for this entity.`;
  };

  return (
    <div className="space-y-4">
      <Section title="What these journal entries are">
        <p className="text-sm">
          Restatements of inventory on a reproducible lot-level method — not a reconciliation to prior
          book values, which were accumulated estimates. Every figure traces to one of three evidence
          types: a <strong>purchase receipt</strong>, a <strong>usage record</strong>, or a{' '}
          <strong>dated on-hand count</strong> from the pharmacy system. Months before{' '}
          <strong>March 2026</strong> are settled and never receive entries; the one-time opening
          correction (dated 2026-03-01, on the Close JEs sub-tab) sets the starting balance, and each
          open month then posts its own statement below.
        </p>
      </Section>

      <Section title="How a month's numbers are built — the pipeline">
        <div className="space-y-2">
          <Step n={1} title="Actual purchase receipts, FIFO">
            Four years of LifeFile Drug Receiving — ~15,300 lots across the three pharmacies, each
            carrying its real invoice cost. Consumption always draws the oldest open lot for that
            product at that location, at that lot&rsquo;s actual cost. No standard costs, no estimates.
          </Step>
          <div className="flex justify-center"><ArrowDown className={`w-4 h-4 ${subText}`} aria-hidden /></div>
          <Step n={2} title="Recorded usage depletes the lots (COGS)">
            LifeFile&rsquo;s per-pharmacy ingredient and dispensing usage, refreshed nightly, consumes
            lots in FIFO order. This is the usage-driven Cost of Goods Sold — posted to each
            category&rsquo;s own COGS account (5000.05 Commercial RX, 5000.10 Compound Ingredient, …).
          </Step>
          <div className="flex justify-center"><ArrowDown className={`w-4 h-4 ${subText}`} aria-hidden /></div>
          <Step n={3} title="Documented disposal is written off on its date (Waste)">
            The pharmacy system&rsquo;s Lot Inventory Adjustment log — expirations, destruction, waste,
            spillage, shelf-count corrections; each entry dated, lot-level, and attributed to the staff
            member who recorded it — depletes the matching purchased lot at receipt cost on the
            adjustment date. Disposal the ledger had already consumed through usage is <em>not</em>{' '}
            charged twice; the gap between the documented record and the booked write-off is tracked and
            disclosed.
          </Step>
          <div className="flex justify-center"><ArrowDown className={`w-4 h-4 ${subText}`} aria-hidden /></div>
          <Step n={4} title="Each month-end is anchored to a real count (Shrink)">
            Every recent month-end is pinned to LifeFile&rsquo;s retroactive Balance-On-Hand count. Any
            remaining gap between the roll-forward and the count is written down in that month — the
            residual shrink. <strong>Write-down only:</strong> a count above the roll-forward is
            investigated, never booked as found stock. A product the count doesn&rsquo;t list is treated
            as zero on hand (a balance listing prints only what it holds); that portion runs
            $24–44K/month and is disclosed separately.
          </Step>
          <div className="flex justify-center"><ArrowDown className={`w-4 h-4 ${subText}`} aria-hidden /></div>
          <Step n={5} title="The journal entry">
            Inventory sub-accounts are set to the count-anchored ending; usage COGS goes to the category
            COGS accounts; waste and shrink post together to the dedicated{' '}
            <strong>5000.55 Drug Waste &amp; Shrinkage</strong> line — two memos, one account — never
            commingled with operating COGS. Beginning + Purchases − COGS − Waste − Shrink = Ending, to
            the cent, every month, every entity.
          </Step>
        </div>
      </Section>

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

      {!data && !error && (
        <div className={`rounded-xl shadow-sm p-10 ${cardBg} text-center text-sm ${subText}`}>
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-hidden />
          Loading live figures…
        </div>
      )}

      {data && (
        <>
          <Section title="The live monthly statement, per entity">
            <p className={`text-sm ${subText}`}>
              Pulled from the FIFO valuation right now — the same tables the drafts generate from.
              Every row foots: Beginning + Purchases − COGS − Waste − Shrink = Ending.
              {!data.wasteShrinkAvailable &&
                ' (Waste/shrink columns not yet present in this environment — showing consumption unsplit.)'}
            </p>
            {Object.entries(data.statements).map(([location, rows]) => (
              <div key={location} className="overflow-x-auto">
                <p className="text-sm font-medium mt-2">{location}</p>
                <table className="text-sm w-full">
                  <thead>
                    <tr>
                      <th className={thCls}>Month</th>
                      <th className={numTh}>Beginning</th>
                      <th className={numTh}>Purchases</th>
                      <th className={numTh}>COGS (usage)</th>
                      <th className={numTh}>Waste</th>
                      <th className={numTh}>Shrink</th>
                      <th className={numTh}>Ending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.month} className={r.inProgress ? subText : ''}>
                        <td className="py-1 pr-3">
                          {r.month}
                          {r.inProgress && ' (in progress — not offered)'}
                        </td>
                        <td className={numCls}>{r.beginning === null ? '—' : usd(r.beginning)}</td>
                        <td className={numCls}>{usd(r.purchases)}</td>
                        <td className={numCls}>{usd(r.cogs)}</td>
                        <td className={numCls}>{usd(r.waste)}</td>
                        <td className={numCls}>{usd(r.shrink)}</td>
                        <td className={`${numCls} font-medium`}>{usd(r.ending)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className={`text-xs ${subText}`}>{statementFooter(rows)}</p>
              </div>
            ))}
          </Section>

          <Section title="Control: two independent methods must agree">
            <p className={`text-sm ${subText}`}>
              Each month is valued two ways — <strong>forward</strong> from receipts and usage (the
              figures above), and <strong>backward</strong> from the current counted position, a
              separate reconstruction that shares none of the forward method&rsquo;s steps. March 2026
              opened this project at 11.6× apart; a month is not offered for posting unless they agree
              within 25%.
            </p>
            <div className="overflow-x-auto">
              <table className="text-sm w-full max-w-xl">
                <thead>
                  <tr>
                    <th className={thCls}>Month</th>
                    <th className={numTh}>Forward (FIFO)</th>
                    <th className={numTh}>Backward (reconstruction)</th>
                    <th className={numTh}>Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {data.convergence.map((c) => (
                    <tr key={c.month}>
                      <td className="py-1 pr-3">{c.month}</td>
                      <td className={numCls}>{usd(c.forward)}</td>
                      <td className={numCls}>{usd(c.backward)}</td>
                      <td className={`${numCls} font-medium`}>{c.ratio === null ? '—' : `${c.ratio.toFixed(2)}×`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      <Section title="Where every dollar posts">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr>
                <th className={thCls}>What</th>
                <th className={thCls}>Account</th>
                <th className={thCls}>Cadence</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr>
                <td className="py-1 pr-3">Inventory balances (by category)</td>
                <td className="py-1 pr-3">
                  1220.05 Commercial Rx · 1220.10 Compound Ingredient · 1220.15 Compound Packaging ·
                  1220.20 Lab Supplies (OTC / Shipping / Suspense are out of the method&rsquo;s scope and
                  untouched)
                </td>
                <td className="py-1 pr-3">monthly, to the count-anchored ending</td>
              </tr>
              <tr>
                <td className="py-1 pr-3">Usage-driven COGS</td>
                <td className="py-1 pr-3">5000.05 / 5000.10 / … (each category&rsquo;s own COGS account)</td>
                <td className="py-1 pr-3">monthly</td>
              </tr>
              <tr>
                <td className="py-1 pr-3">Waste + shrink</td>
                <td className="py-1 pr-3">
                  <strong>5000.55 Drug Waste &amp; Shrinkage</strong> — created 2026-08-26 in all three
                  companies; two memo trails (documented disposal vs. count residual), one account.
                  Distinct from 5000.43 Product Losses (shipping) and TN&rsquo;s retired 6999.33.
                </td>
                <td className="py-1 pr-3">monthly</td>
              </tr>
              <tr>
                <td className="py-1 pr-3">Opening correction (cutover)</td>
                <td className="py-1 pr-3">
                  5000.60 Inventory Valuation Correction (proposed — pending CPA sign-off; the card on
                  the Close JEs sub-tab refuses to draft until it exists)
                </td>
                <td className="py-1 pr-3">once, dated 2026-03-01</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <div className={`rounded-xl shadow-sm ${cardBg} p-4`}>
        <details>
          <summary className="text-sm font-semibold cursor-pointer select-none">
            Glossary — what these words mean here
          </summary>
          <dl className="mt-3 space-y-2 text-sm">
            {GLOSSARY.map(([term, def]) => (
              <div key={term} className={`rounded-lg ${stepBg} p-2.5`}>
                <dt className="font-medium">{term}</dt>
                <dd className={subText}>{def}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>

      <Section title="Stated plainly — limitations and disclosures">
        <ul className={`text-sm list-disc pl-5 space-y-1`}>
          <li>
            The month-end &ldquo;count&rdquo; is the pharmacy system&rsquo;s recorded on-hand, not a
            physical hand count (retroactive pulls reproduce the independently-stored copy of the same
            month at 98.2%). A physical count, where taken, supersedes it.
          </li>
          <li>
            Florida compounded on the Pioneer system until early 2025: $2.45M of pre-conversion
            purchases are excluded as a flagged, auditable bucket — corroborated by Pioneer&rsquo;s own
            fill records showing $2.57M of ingredient consumption in the same window.
          </li>
          <li>
            Products absent from a month&rsquo;s count are written to zero ($24–44K/month, disclosed) —
            a balance listing prints only what it holds, so absence is read as the count stating zero.
          </li>
          <li>
            The pharmacy system&rsquo;s own &ldquo;product value&rdquo; column disagrees with itself
            between capture paths by 3–8× and is used nowhere — all pricing comes from our receipts.
          </li>
          <li>
            Full decision record: <span className="font-mono">docs/fifo-monthly-close/</span> in the
            Accounting-Analytics repo — the method note, the correction proposal, and the 36-section
            build log with every ruling dated.
          </li>
        </ul>
      </Section>
    </div>
  );
}
