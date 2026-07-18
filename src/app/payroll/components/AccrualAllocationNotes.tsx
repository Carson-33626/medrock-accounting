'use client';

import { DirectionsBanner } from './DirectionsBanner';

/**
 * Collapsible review note pinned to the top of /payroll. Documents the month-end accrual +
 * admin-wage allocation setup (go-live: January 2026) and the findings from regenerating
 * January's entries and comparing them against Amy's actual QuickBooks entries.
 *
 * Reference/review only — no data, no side effects. The setup is locked in (2026-07); the
 * "open items" below are accounting decisions left for Barbara to review next session. These
 * entries are generated for review — nothing has been posted to QuickBooks.
 */
export function AccrualAllocationNotes({ darkMode }: { darkMode: boolean }) {
  return (
    <DirectionsBanner
      darkMode={darkMode}
      title="Accrual & admin-wage allocation — setup & review notes (for Barbara)"
    >
      <div className="space-y-3">
        <div>
          <p className="font-semibold">What&apos;s set up — go-live January 2026 (dry-run only, nothing posted yet)</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <span className="font-medium">Month-end accrual.</span> Payroll earned in a month but
              paid the next month is accrued at month end (<code>PR Accru YYYY.MM</code>) and reversed
              on day 1 of the next month (<code>…MMR</code>) — Amy&apos;s accrue-and-reverse pattern,
              expense lines only, day-prorated.
            </li>
            <li>
              <span className="font-medium">Admin-wage allocation.</span> <code>ADMIN</code> regular
              wages are split across MedRock FL / TN / TX — currently{' '}
              <span className="font-medium">⅓ each</span> — via a standalone month-end inter-entity
              JE hubbed through FL (<code>&lt;ENT&gt; % Allo YYYY.MM</code>). Percentages are editable
              in the <span className="font-medium">Mappings</span> tab.
            </li>
          </ul>
        </div>

        <div>
          <p className="font-semibold">January regeneration vs Amy&apos;s actual entries — what we found</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <span className="font-medium">Allocation.</span> At ⅓, TX picks up{' '}
              <span className="font-mono">$21,388</span> and FL sheds{' '}
              <span className="font-mono">$21,722</span> (TN is already ≈ a third). FL currently
              carries most admin staff and TX carries almost none, so a flat ⅓ shifts a large amount
              onto TX. <span className="font-medium">⅓ is a placeholder — the real split needs to be chosen.</span>
            </li>
            <li>
              <span className="font-medium">Accrual size.</span> Ours runs larger than Amy&apos;s
              (e.g. TX January <span className="font-mono">$4,281</span> vs Amy&apos;s{' '}
              <span className="font-mono">$1,645</span>) because we accrue every &ldquo;worked this
              month / paid next month&rdquo; run in full — a complete month-end cutoff — where Amy
              booked only small straddle-day accruals.
            </li>
            <li>
              <span className="font-medium">Non-expense lines.</span> The accrual currently also
              sweeps in car-allowance, medical-ER, and reimbursement amounts that are booked to
              liability accounts (not expenses); they self-net and should not be accrued.
            </li>
          </ul>
        </div>

        <div>
          <p className="font-semibold">Open items for Barbara&apos;s review</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Choose the real ADMIN allocation percentages (replace the ⅓ placeholder in Mappings).</li>
            <li>Accrual scope: keep the full month-end cutoff, or narrow it to Amy&apos;s straddle-only approach?</li>
            <li>Approve the cleanup to accrue only wage/tax expense accounts (exclude car allowance / medical-ER / reimbursements).</li>
          </ol>
        </div>

        <p className="text-xs opacity-75">
          Set up July 2026 · reference only · these entries are generated for review and nothing has
          been posted to QuickBooks.
        </p>
      </div>
    </DirectionsBanner>
  );
}
