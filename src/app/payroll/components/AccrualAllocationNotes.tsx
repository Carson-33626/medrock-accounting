'use client';

import { DirectionsBanner } from './DirectionsBanner';

type NotesView = 'payrolls' | 'endofmonth' | 'mappings';

/**
 * Collapsible status note pinned to the top of /payroll, scoped to the active tab:
 * payroll-JE status on Payrolls (and draft detail), month-end allocation status on
 * End of Month, and a mappings guide on Mappings.
 *
 * Reference/review only — no data, no side effects. All entries are generated as drafts
 * for review — nothing posts to QuickBooks without explicit approval.
 */
export function AccrualAllocationNotes({ darkMode, view }: { darkMode: boolean; view: NotesView }) {
  if (view === 'endofmonth') {
    return (
      <DirectionsBanner
        darkMode={darkMode}
        title="Month-end allocation status — what's live, what needs Barbara"
      >
        <div className="space-y-3">
          <div>
            <p className="font-semibold">Live since 7/29 — drafts only, nothing posts without approval</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Each month&apos;s <span className="font-medium">Allocate-flagged costs</span> (location{' '}
                <code>% Allocation</code> / <code>Allocate - *</code> classes) are pulled from all three
                QuickBooks companies and split by the <span className="font-medium">revenue rule</span>:
                equal shares among locations with revenue that month (3 → ⅓ each, 2 → 50/50, 1 → 100%).{' '}
                <code>Allocate - SplitX3</code> items always split ⅓; <code>Split TN50/FL50</code> split 50/50.
              </li>
              <li>
                <span className="font-medium">100% reassignment classes</span> (<code>Allocate - FL/TN/TX</code>)
                are already booked per-transaction by QuickBooks&apos; intercompany feature — they appear in
                the Attention list here for visibility and are never re-allocated.
              </li>
              <li>
                Generated drafts mirror Amy&apos;s month-end JEs (doc <code>FL % Allo 2026.03</code> style,
                month-end date, due-to/due-from legs) and post only after per-draft approval. Backfill
                target: <span className="font-medium">March–June 2026</span>, then July after close.
              </li>
            </ul>
          </div>

          <div>
            <p className="font-semibold">Waiting on Barbara</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Review and approve each month&apos;s drafts — start with the March generation and read its
                account warnings before approving.
              </li>
              <li>
                Sign-off on <span className="font-medium">balance-sheet accounts</span> in the pool (Accrued
                Payroll Liability, Accrued Expenses) moving between entities — they carry the Allocate flag
                today, so the system allocates them.
              </li>
              <li>
                <span className="font-medium">CSR wages stay in the pool for now</span> (matches Amy&apos;s
                convention) but are under review — they may become location-owned later.
              </li>
            </ul>
          </div>

          <p className="text-xs opacity-75">
            Updated July 2026 · reference only · the manual percentage editor in Mappings was retired 7/29.
          </p>
        </div>
      </DirectionsBanner>
    );
  }

  if (view === 'mappings') {
    return (
      <DirectionsBanner darkMode={darkMode} title="How mappings drive the journal entries">
        <div className="space-y-3">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <span className="font-medium">Account rules</span> map each ADP column (by cost center) to a
              QuickBooks account and posting side — they decide <em>where dollars land</em>.
            </li>
            <li>
              <span className="font-medium">Employee rules</span> assign each position a department (region)
              and class — they decide <em>how lines are dimensioned</em>.
            </li>
            <li>
              A class of <code>Allocate - %</code> automatically forces the line&apos;s location to{' '}
              <code>% Allocation</code> (since 7/29), which feeds the month-end allocation pool on the End of
              Month tab. The cost-center label stays in the line memo.
            </li>
            <li>
              The manual admin-wage percentage editor was <span className="font-medium">retired 7/29</span> —
              splits are computed monthly by the revenue rule on the End of Month tab.
            </li>
          </ul>
          <p className="text-xs opacity-75">
            Mapping changes affect the next build/rebuild of a draft — already-posted JEs never change.
          </p>
        </div>
      </DirectionsBanner>
    );
  }

  return (
    <DirectionsBanner darkMode={darkMode} title="Payroll JE status — what's live, what's parked">
      <div className="space-y-3">
        <div>
          <p className="font-semibold">Live now (July 2026) — drafts only, nothing posted to QuickBooks</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <span className="font-medium">Month-crossing payrolls are split.</span> A pay period
              that straddles a month boundary becomes <span className="font-medium">two journal
              entries</span> — one per calendar month, every line day-prorated (e.g.{' '}
              <code>PR 2026.07.10A</code> dated 6/30 + <code>PR 2026.07.10B</code> dated 7/10).
              Affected payrolls carry a <code>Split</code> badge, open with per-month sub-tabs plus
              a Combined view, show a grand reconciliation summary at the bottom, and are approved
              and posted <span className="font-medium">as a pair</span>. A period wholly inside one
              month but paid the next still posts on its pay date.
            </li>
            <li>
              <span className="font-medium">Cost-center dimensioning.</span> Since 7/23 every JE
              line is dimensioned by cost center on both sides (memo{' '}
              <code>&lt;Label&gt; - &lt;Dept&gt;</code>), dollar-neutral.
            </li>
            <li>
              <span className="font-medium">Allocate-pool lines feed month-end.</span> Since 7/29,
              lines classed <code>Allocate - %</code> (admin, CSR, R&amp;D wages and their
              taxes/benefits) carry location <code>% Allocation</code> so the End of Month tab picks
              them up. On the next rebuild of an existing draft those line counts and ordering
              shift — <span className="font-medium">dollars and memos are unchanged</span>.
            </li>
          </ul>
        </div>

        <div>
          <p className="font-semibold">Parked — month-end accrual (superseded by the split)</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              The accrue-and-reverse engine (<code>PR Accru YYYY.MM</code> / <code>…MMR</code>,
              Amy&apos;s pattern) is built and dry-run validated but{' '}
              <span className="font-medium">not wired up</span> — Barbara chose real split JEs for
              straddling periods instead, which replaces the accrual for those runs.
            </li>
          </ul>
        </div>

        <p className="text-xs opacity-75">
          Updated July 2026 · reference only · month-end allocation status lives on the End of Month tab.
        </p>
      </div>
    </DirectionsBanner>
  );
}
