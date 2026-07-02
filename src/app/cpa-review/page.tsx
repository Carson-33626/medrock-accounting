'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';

export const dynamic = 'force-dynamic';

export default function CompanyCpaReviewPage() {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const cardBorder = darkMode ? 'border-slate-700' : 'border-slate-200';

  const shared = { cardBg, subText, cardBorder, darkMode };

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Company</p>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Accounting Review Topics
          </h1>
        </div>

        <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
          <p className="text-sm font-semibold mb-2">What lands here</p>
          <p className={`text-sm ${subText}`}>
            Company-level review material for our CPA, <strong>Barbara</strong> — kept out of the per-state tax pages so
            those stay strictly about filing. <strong>Open topics</strong> are queued for a decision;{' '}
            <strong>resolved</strong> items (with the
            decision and date) are kept at the bottom for the record. Each one points to where in the app the underlying
            numbers live.
          </p>
        </div>

        {/* ---------------- OPEN ---------------- */}
        <div className="space-y-4">
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Open topics for the CPA</p>

          <Topic
            {...shared}
            tag="Use Tax"
            title="Use-tax figure — QuickBooks &ldquo;Use Tax on Purchases&rdquo; account (DR-15 E7 · TN SLS-450 Line 3)"
            where={
              <>
                Not yet surfaced in a page — it is a QuickBooks Chart-of-Accounts figure (<strong>MedRock Florida acct
                294</strong> / <strong>MedRock Tennessee acct 340</strong>). Feeds Sales Tax → <strong>Florida → FL ·
                DR-15</strong> (the E7 &ldquo;Sales Use&rdquo; line) and <strong>Tennessee → TN · SLS-450</strong> (Line
                3).
              </>
            }
          >
            We traced the use-tax number to QuickBooks: each entity posts it to an Expense account named{' '}
            <strong>General &amp; Administrative — Use Tax on Purchases</strong> (MedRock Florida <strong>acct 294</strong>,
            MedRock Tennessee <strong>acct 340</strong>). This is the source for two figures the tool <em>cannot</em> get
            from LifeFile: the <strong>FL DR-15 use-tax line</strong> (E7 → F7, today keyed in by hand) and the{' '}
            <strong>TN SLS-450 Line 3</strong> out-of-state purchase use tax ($18,544 in CY2025). We can pull it per
            period automatically via the QB General Ledger report — observed FL activity was $596.79 (Mar 2026), $374.23
            (Apr), $33.25 (May) of debits, with smaller offsetting credits. <strong>For Barbara: (1)</strong> does this
            account hold the use-tax <em>dollars</em> already computed (it appears to), or the taxable-purchase{' '}
            <em>base</em> that still needs × 8.5% (FL) / the TN rate? <strong>(2)</strong> are the periodic credit entries
            legitimate reversals to net against the debits, or something else? <strong>(3)</strong> confirm this account
            is the authoritative source and is posted every period, so it is safe to pull automatically into the returns.
          </Topic>

          <Topic
            {...shared}
            tag="Texas"
            title="Taxable-sales method change (Texas returns)"
            where={
              <>
                Sales Tax → <strong>Florida → TX · 01-114</strong> and <strong>Texas → TX · 01-114</strong> — the
                &ldquo;Taxable Sales&rdquo; line and method note on each Texas return page.
              </>
            }
          >
            Both Texas returns now compute <strong>Taxable Sales by backing tax out of the combined rate</strong> (tax ÷
            8.0%/8.25%, capped at each order&apos;s subtotal) — the same method as the FL DR-15, which isolates the
            taxable portion of partially-exempt Rx orders. The last filed <strong>MedRock Florida</strong> TX return used
            Σ-subtotal instead, which overstated the base (it remitted $21.29 on $258 when only $8.23 was collected). The
            new tool&apos;s figures will intentionally differ from that return. <strong>Confirm acceptable, and whether to
            amend the prior FL-entity return.</strong>
          </Topic>

          <Topic
            {...shared}
            tag="Texas"
            title="Local tax sourcing — origin (Colleyville) vs destination"
            where={
              <>
                Sales Tax → <strong>Texas → TX · 01-114</strong> (MedRock Texas&apos;s return) — the per-jurisdiction
                local breakdown and the origin-sourcing caption beneath it.
              </>
            }
          >
            MedRock Texas ships to patient cities all over the state, so which local jurisdiction gets the local tax is a
            fair question. As an <strong>in-state seller</strong>, Texas sources local tax to the{' '}
            <strong>place of business (Colleyville)</strong>, not the delivery address — and because the combined local
            cap is <strong>2%</strong> and Colleyville is already at 2% (1.5% city + 0.5% crime control), no additional
            destination local tax can be owed. So <strong>MedRock&apos;s total liability is the same regardless of ship-to
            city</strong>; origin vs destination only changes which jurisdiction the Comptroller credits. The tool files
            origin-Colleyville (matching the prior return); a Dec-2025 district court ruling invalidated the
            destination-leaning Rule 3.334 amendment, favoring origin. <strong>Confirm origin sourcing is the position to
            keep.</strong> (The MedRock Florida remote-seller return sidesteps this entirely via the single 1.75% rate.)
          </Topic>

          <Topic
            {...shared}
            tag="Texas"
            title="Texas permit effective date — February 2026"
            where={
              <>
                Sales Tax → <strong>Florida → TX · 01-114</strong> and <strong>Texas → TX · 01-114</strong> — the
                quarter picker (Q1-2026 covers Feb–Mar only).
              </>
            }
          >
            Both Texas Sales &amp; Use Tax permits appear effective <strong>Feb 1, 2026</strong> (neither entity has any
            January 2026 TX rows; both Q1 returns covered Feb+Mar only). The generator floors at 2026-02 and excludes
            January. <strong>Confirm January 2026 Texas sales carried no filing obligation.</strong>
          </Topic>

          <Topic
            {...shared}
            tag="Tennessee"
            title="TN SLS-450 — amend CY2025? + out-of-state purchase use-tax source"
            where={
              <>
                Sales Tax → <strong>Tennessee → TN · SLS-450</strong> — the Line 3 out-of-state-purchase use-tax input
                and the CY2025 note.
              </>
            }
          >
            With the Gross method now settled (see Resolved below), two items remain: <strong>(1)</strong> the filed{' '}
            <strong>CY2025</strong> return diverged from that method — it reported Gross of only <strong>$6,609</strong>{' '}
            with no exemptions (plus $18,544 out-of-state purchase use tax), taxing $25,153 for $2,327. Should it be{' '}
            <strong>amended</strong> to the full-gross / all-exempt-but-TN-taxable basis? (Net tax ≈ unchanged; it&apos;s
            a presentation/consistency call — 3-year window, open through Dec 31 2029.) <strong>(2)</strong> The{' '}
            <strong>out-of-state purchase use tax</strong> (Line 3, $18,544 in CY2025) is a QuickBooks figure the tool
            can&apos;t source from LifeFile — <strong>now located:</strong> QB account <strong>340</strong>, &ldquo;Use Tax
            on Purchases&rdquo; (see the <em>Use Tax</em> topic above). The open part is just confirming the CY2025 $18,544
            reconciles to that account and that it&apos;s posted each year (it is the actual driver of TN tax owed).
          </Topic>

          <Topic
            {...shared}
            tag="Nexus"
            title="Economic-nexus signal (post-Wayfair)"
            where={
              <>
                <strong>Nexus Exposure</strong> — per-state ship-to gross sales + transaction counts vs each
                state&apos;s verified threshold, with over / approaching / registered flags and CSV/Excel export.
              </>
            }
          >
            MedRock ships nationwide, so economic nexus (post-<em>Wayfair</em>) can attach in states beyond FL/TX/TN/GA/NC
            even though Rx is exempt almost everywhere (crossing a threshold creates a registration/filing duty regardless
            of tax due). The <strong>Nexus Exposure</strong> page screens YTD-2026 ship-to sales (annualized) against the
            2026 threshold table — several states (e.g. CO, OH, MA, SC, AZ, IL) are already over $100k gross, and GA&apos;s
            still-active 200-transaction prong is well past. <strong>This is the data input for a CPA-led nexus study</strong>{' '}
            to decide where to register; figures are gross-basis and YTD, not a filing determination.
          </Topic>
        </div>

        {/* ---------------- RESOLVED ---------------- */}
        <div className="space-y-4 pt-2">
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Resolved / decided</p>

          <Topic
            {...shared}
            resolved
            tag="Texas"
            title="Single local use tax rate election — Form 01-799 (MEDROCK PHARMACY LLC)"
            decision={
              <>
                <strong>Approved (2026-06-17).</strong> Use the single local use tax rate (1.75% → 8.00% combined) for the
                MedRock Florida remote-seller TX return. Action: file <strong>Form 01-799</strong> by email to{' '}
                <code>sales.applications@cpa.texas.gov</code> (or mail) for MEDROCK PHARMACY LLC (taxpayer 32089108859) —
                steps are on the <strong>Florida → TX</strong> page. Forward-only (effective the start of a reporting
                period), so file before the quarter it should first apply to; stays in effect until revoked.
              </>
            }
            where={
              <>
                Sales Tax → <strong>Florida → TX · 01-114</strong> — the single-rate election note with the filing steps.
              </>
            }
          >
            The Florida entity is an out-of-state <strong>remote seller</strong>, eligible for the single local use tax
            rate instead of per-destination jurisdiction sourcing — it collapses local tax to one flat line and is the
            correct remote-seller treatment.
          </Topic>

          <Topic
            {...shared}
            resolved
            tag="Tennessee"
            title="TN SLS-450 — Gross Sales method"
            decision={
              <>
                <strong>Confirmed (2026-06-17).</strong> Gross Sales (Line 1) = <strong>total sales</strong> for MEDROCK
                TN LLC across <strong>every ship-to state</strong>, then exempt everything except the TN-taxable items
                (out-of-state on Schedule A Line 7, exempt Rx on Line 9) — matches the SLS-450 instructions. The tool was
                updated to this basis (Gross is no longer scoped to TN-delivered sales; the taxable backout stays
                TN-only). CY2026 Gross moves from ~$1.28M to ~$5.84M with tax unchanged.
              </>
            }
            where={
              <>
                Sales Tax → <strong>Tennessee → TN · SLS-450</strong> — the method banner and the &ldquo;Gross by ship-to
                state&rdquo; breakdown.
              </>
            }
          >
            The earlier question was whether Gross should be only TN-delivered sales or the entity&apos;s full dispensing
            volume across all states. The all-ship-to basis (with out-of-state deducted) is the instruction-conformant
            answer and reconciles to the F&amp;E / Business-Tax gross.
          </Topic>
        </div>
      </div>
    </div>
  );
}

function Topic({
  cardBg,
  subText,
  cardBorder,
  darkMode,
  tag,
  title,
  where,
  decision,
  resolved,
  children,
}: {
  cardBg: string;
  subText: string;
  cardBorder: string;
  darkMode: boolean;
  tag: string;
  title: string;
  where: React.ReactNode;
  decision?: React.ReactNode;
  resolved?: boolean;
  children: React.ReactNode;
}) {
  const decisionBox = darkMode
    ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-200'
    : 'bg-emerald-50 border-emerald-200 text-emerald-900';
  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg} ${resolved ? 'opacity-95' : ''}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-semibold uppercase tracking-wide">
          {tag}
        </span>
        {resolved && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-semibold uppercase tracking-wide">
            ✓ Resolved
          </span>
        )}
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <p className={`text-sm ${subText}`}>{children}</p>
      {decision && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${decisionBox}`}>
          <span className="block text-[10px] font-semibold uppercase tracking-wide mb-0.5">Decision</span>
          {decision}
        </div>
      )}
      <p className={`mt-3 pt-3 border-t ${cardBorder} text-xs ${subText}`}>
        <span aria-hidden className="mr-1">📍</span>
        <span className="font-semibold uppercase tracking-wide">Where to find it: </span>
        {where}
      </p>
    </div>
  );
}
