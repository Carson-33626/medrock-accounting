'use client';

/**
 * Inventory Decisions — the review surface for ownership (Ash): every material
 * decision behind the inventory system, dated, with its rationale and status.
 * Curated from the full decision record in the Accounting-Analytics repo
 * (docs/fifo-monthly-close/ — the DS build log, the method note, and the
 * correction proposal). Shared as a sub-tab by the Inventory Valuation page and
 * the Inventory Close tab.
 */

type DecisionStatus = 'decided' | 'pending_cpa' | 'pending_ruling';

interface Decision {
  date: string;
  title: string;
  decision: string;
  why: string;
  status: DecisionStatus;
}

const DECISIONS: Decision[] = [
  {
    date: '2026-08-26',
    title: 'Cutover: March 2026 forward runs on the FIFO system',
    decision:
      'Periods through February 2026 are settled and never restated. March 2026 forward posts from the lot-level FIFO valuation, beginning with a one-time opening correction.',
    why:
      'The old book balances were accumulated estimates with no lot-level support. A clean stop point keeps history final while every open month becomes traceable to receipts, usage records, and dated counts.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Opening correction: $1,543,975 write-down, dated 2026-03-01',
    decision:
      'One JE per company (FL $669,503 · TN $621,672 · TX $252,801) trues each inventory sub-account to the FIFO opening. OTC, shipping packaging, and suspense accounts are out of scope and untouched.',
    why:
      'The inventory accounts had been frozen since before February — purchases were expensing straight to COGS — so a single dated correction sets the opening with nothing to unwind. Offset account (5000.60 proposed) awaits CPA sign-off.',
    status: 'pending_cpa',
  },
  {
    date: '2026-08-25',
    title: 'Waste and shrink get their own account: 5000.55, never mixed into COGS',
    decision:
      'Documented disposal and count-residual shrink post together to 5000.55 Drug Waste & Shrinkage (created in all three companies), with separate memo trails. Operating COGS carries only usage-driven consumption.',
    why:
      'Waste is a managed cost with its own trend; folding it into COGS hides both numbers. TN’s legacy 6999.33 stays retired; 5000.43 Product Losses (shipping) stays separate.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Monthly count anchoring, write-down only',
    decision:
      'Every month-end in the anchor window is pinned to LifeFile’s Balance-On-Hand count for that date. Gaps write DOWN in that month as shrink; a count above the roll-forward is investigated, never booked as found stock.',
    why:
      'Usage records alone miss compounding loss and unlogged disposal. A dated count per month keeps every ending real and every shrink figure measured, not estimated — and the conservative direction means the books never overstate.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Four years of accumulated drift discharges at 2025-12 — before anything posts',
    decision:
      'The ~$1.9M of unrecorded pre-anchor shrink is written off at the first counted month-end (December 2025), inside settled, simulation-only territory. No journal entry ever carries it.',
    why:
      'The drift is real but belongs to no single open month. Discharging it before the postable window keeps every posted month clean — each carries only its own measured $150–216K of shrink.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Documented disposal books only what the ledger still held',
    decision:
      'The disposal log documents $319K across four years; only the portion the ledger had not already consumed through usage (~$96K) is written off as waste. The gap is disclosed, never charged twice.',
    why:
      'Stock consumed on paper by usage is already in COGS — writing it off again as waste would double-count the same dollars and over-credit inventory. Measured impact of this ruling: 70% of the documented figure.',
    status: 'decided',
  },
  {
    date: '2026-08-25',
    title: 'Florida’s Pioneer-era purchases excluded: $2.45M, corroborated',
    decision:
      'Compounding purchases from before Florida’s LifeFile conversion are held out of valuation as a flagged, auditable bucket. Nothing is deleted; no entry posts from it.',
    why:
      'Florida compounded on the Pioneer system then, so LifeFile has no usage to deplete those lots against. Pioneer’s own fill records show $2.57M of ingredient consumption in the same window — the stock was genuinely used in its era.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Products absent from a count are treated as zero on hand',
    decision:
      'A balance listing prints only what it holds, so absence is read as the count stating zero. The write-down runs $24–44K/month in postable months and is disclosed separately inside shrink.',
    why:
      'The alternative — holding unconfirmed stock at roll-forward — would carry ~$600K the counts never affirm, indefinitely. The ~10 products no count has ever listed ($37K, mostly identity-fragment suspects) go to ops for one-time review. Formal ruling pending; deployed behavior matches this recommendation.',
    status: 'pending_ruling',
  },
  {
    date: '2026-08-26',
    title: 'One valuation basis: receipt-priced',
    decision:
      'Everything is valued at the actual purchase price of the lots it sits in; only stock traceable to a priced receipt is counted. The former full-coverage estimate was removed.',
    why:
      'Receipt coverage exceeds 99.4% of on-hand value, so the estimate converged to within 0.6% of the floor — two labels for one number is reviewer noise. The conservative basis is the one accounting reads.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Nothing posts without passing the gates',
    decision:
      'A month is offered for posting only when the automated acceptance board is green, the forward and backward valuations agree within 25%, and the ending ties to a dated count. Every draft then requires an explicit human approve before it reaches QuickBooks.',
    why:
      'The controls are the method’s credibility: two independent valuations agreeing (currently 2–18% apart on open months, from 1,060% at the start) is evidence the numbers are real rather than self-consistent. August 2026 is the first fully-live month end-to-end.',
    status: 'decided',
  },
  {
    date: '2026-08-26',
    title: 'Usage data: per-pharmacy nightly feed, history to 2022',
    decision:
      'LifeFile usage is pulled nightly per pharmacy (live since 2026-08-26), with backfilled history to 2022-08. Fifty unattributable rows (0.614% of one table, filed under no location in LifeFile) were dropped, with the full rows preserved in a manifest.',
    why:
      'Location-level usage is what makes per-pharmacy valuation and per-company JEs possible; the backfill is what made TN’s consumption history complete enough to trust the depletion.',
    status: 'decided',
  },
];

const STATUS_META: Record<DecisionStatus, { label: string; light: string; dark: string }> = {
  decided: { label: 'Decided', light: 'bg-emerald-100 text-emerald-800', dark: 'bg-emerald-900/60 text-emerald-200' },
  pending_cpa: { label: 'Pending CPA sign-off', light: 'bg-amber-100 text-amber-800', dark: 'bg-amber-900/60 text-amber-200' },
  pending_ruling: { label: 'Ruling pending', light: 'bg-blue-100 text-blue-800', dark: 'bg-blue-900/60 text-blue-200' },
};

export function InventoryDecisions({ darkMode }: { darkMode: boolean }) {
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  return (
    <div className="space-y-4">
      <div className={`rounded-xl shadow-sm ${cardBg} p-4`}>
        <h3 className="text-sm font-semibold">Inventory decisions — the record behind the numbers</h3>
        <p className={`text-sm mt-1 ${subText}`}>
          Every material decision in the inventory system, dated, with its rationale and current status.
          Curated from the full decision log (36 dated sections) in the Accounting-Analytics repo under{' '}
          <span className="font-mono">docs/fifo-monthly-close/</span> — the build log, the CPA method
          note, and the opening-correction proposal. Questions on any item trace back to its dated
          section there.
        </p>
      </div>

      {DECISIONS.map((d) => {
        const meta = STATUS_META[d.status];
        return (
          <div key={d.title} className={`rounded-xl shadow-sm ${cardBg} p-4`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs tabular-nums ${subText}`}>{d.date}</span>
              <h4 className="text-sm font-semibold">{d.title}</h4>
              <span
                className={`ml-auto px-2 py-0.5 rounded-full text-xs font-medium ${darkMode ? meta.dark : meta.light}`}
              >
                {meta.label}
              </span>
            </div>
            <div className={`mt-2 rounded-lg border ${border} p-3 text-sm`}>{d.decision}</div>
            <p className={`mt-2 text-sm ${subText}`}>
              <span className="font-semibold">Why: </span>
              {d.why}
            </p>
          </div>
        );
      })}
    </div>
  );
}
