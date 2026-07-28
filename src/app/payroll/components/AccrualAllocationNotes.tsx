'use client';

import { DirectionsBanner } from './DirectionsBanner';

/**
 * Collapsible status note pinned to the top of /payroll. Reflects the current state of the
 * payroll JE automation: what's live (month-crossing split, cost-center dimensioning), what's
 * parked (the accrual/reversal path, superseded for straddlers), and the accounting decisions
 * still waiting on Barbara (admin-wage allocation percentages).
 *
 * Reference/review only — no data, no side effects. All entries are generated as drafts for
 * review — nothing has been posted to QuickBooks.
 */
export function AccrualAllocationNotes({ darkMode }: { darkMode: boolean }) {
  return (
    <DirectionsBanner
      darkMode={darkMode}
      title="Payroll JE status — what's live, what's parked, what needs Barbara"
    >
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
              and posted <span className="font-medium">as a pair</span>. All 2026 drafts were
              regenerated with this on 7/27 (25 straddling runs are now split pairs). A period
              wholly inside one month but paid the next still posts on its pay date.
            </li>
            <li>
              <span className="font-medium">Cost-center dimensioning.</span> Since 7/23 every JE
              line is dimensioned by cost center on both sides (memo{' '}
              <code>&lt;Label&gt; - &lt;Dept&gt;</code>), dollar-neutral.
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
              straddling periods instead, which replaces the accrual for those runs. The earlier
              accrual review findings (larger-than-Amy cutoff scope, non-expense lines swept in)
              are moot while it stays parked.
            </li>
          </ul>
        </div>

        <div>
          <p className="font-semibold">Waiting on Barbara — admin-wage allocation</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <code>ADMIN</code> regular wages split across MedRock FL / TN / TX via a standalone
              month-end inter-entity JE hubbed through FL (<code>&lt;ENT&gt; % Allo YYYY.MM</code>).
              The current <span className="font-medium">⅓-each is a placeholder</span>: at ⅓, TX
              picks up <span className="font-mono">$21,388</span> and FL sheds{' '}
              <span className="font-mono">$21,722</span> (January basis) even though FL carries most
              admin staff and TX almost none. Real percentages need to be chosen in the{' '}
              <span className="font-medium">Mappings</span> tab before this goes live.
            </li>
          </ul>
        </div>

        <p className="text-xs opacity-75">
          Updated July 2026 · reference only · all entries are generated as drafts for review and
          nothing has been posted to QuickBooks.
        </p>
      </div>
    </DirectionsBanner>
  );
}
