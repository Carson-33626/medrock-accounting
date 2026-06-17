'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';

export const dynamic = 'force-dynamic';

export default function CompanyCpaReviewPage() {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const cardBorder = darkMode ? 'border-slate-700' : 'border-slate-200';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Company</p>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Company CPA Review
          </h1>
        </div>

        <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
          <p className="text-sm font-semibold mb-2">What lands here</p>
          <p className={`text-sm ${subText}`}>
            Company-level review material for the CPA — kept out of the per-state tax pages so those stay strictly
            about filing. The topics below are the open items queued for review; each one points to where in the app
            the underlying numbers live.
          </p>
        </div>

        <div className="space-y-4">
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Open topics for the CPA</p>

          <Topic
            cardBg={cardBg}
            subText={subText}
            tag="Texas"
            title="Taxable-sales method change (Texas returns)"
            cardBorder={cardBorder}
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
            cardBg={cardBg}
            subText={subText}
            tag="Texas"
            title="Single local use tax rate election — Form 01-799 (MEDROCK PHARMACY LLC)"
            cardBorder={cardBorder}
            where={
              <>
                Sales Tax → <strong>Florida → TX · 01-114</strong> (MedRock Florida&apos;s Texas return) — the amber
                single-rate election note.
              </>
            }
          >
            The Florida entity is an out-of-state <strong>remote seller</strong>, eligible for the single local use tax
            rate (1.75% → 8.00% combined) instead of per-destination jurisdiction sourcing. Recommend{' '}
            <strong>filing Form 01-799</strong> to elect it — it collapses local tax to one flat line and is the correct
            remote-seller treatment. Election is <strong>forward-only</strong> (effective the month after filing); the TX
            page computes at the single rate and flags that the election must be effective for the period filed.
          </Topic>

          <Topic
            cardBg={cardBg}
            subText={subText}
            tag="Texas"
            title="Local tax sourcing — origin (Colleyville) vs destination"
            cardBorder={cardBorder}
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
            cardBg={cardBg}
            subText={subText}
            tag="Texas"
            title="Texas permit effective date — February 2026"
            cardBorder={cardBorder}
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
            cardBg={cardBg}
            subText={subText}
            tag="Tennessee"
            title="TN SLS-450 — confirm prior-return amend + use-tax source"
            cardBorder={cardBorder}
            where={
              <>
                Sales Tax → <strong>Tennessee → TN · SLS-450</strong> — the method banner and the Line 3
                out-of-state-purchase use-tax input.
              </>
            }
          >
            <strong>Method confirmed (Carson, per the prior accountant):</strong> report the full dispensing sales as
            Gross with the non-taxable Rx as Exempt (TN is the home state overseeing the tax profile) — the tool now
            does this. Two items remain: <strong>(1)</strong> The filed <strong>CY2025</strong> return diverged from
            that guidance — it reported Gross of only <strong>$6,609</strong> with no exemptions (plus $18,544
            out-of-state purchase use tax), taxing $25,153 for $2,327. Should that return be <strong>amended</strong> to
            the full-gross/exempt basis? <strong>(2)</strong> The <strong>out-of-state purchase use tax</strong> (Line
            3, $18,544 in CY2025) is a QuickBooks figure the tool can&apos;t source from LifeFile — confirm where it
            comes from and that it&apos;s entered each year.
          </Topic>

          <Topic
            cardBg={cardBg}
            subText={subText}
            tag="Nexus"
            title="Economic-nexus signal (post-Wayfair)"
            cardBorder={cardBorder}
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
            still-active 200-transaction prong is well past. <strong>This is the data input for a CPA-led nexus study</strong>
            to decide where to register; figures are gross-basis and YTD, not a filing determination.
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
  tag,
  title,
  where,
  children,
}: {
  cardBg: string;
  subText: string;
  cardBorder: string;
  tag: string;
  title: string;
  where: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl shadow-sm p-5 ${cardBg}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-semibold uppercase tracking-wide">
          {tag}
        </span>
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <p className={`text-sm ${subText}`}>{children}</p>
      <p className={`mt-3 pt-3 border-t ${cardBorder} text-xs ${subText}`}>
        <span aria-hidden className="mr-1">📍</span>
        <span className="font-semibold uppercase tracking-wide">Where to find it: </span>
        {where}
      </p>
    </div>
  );
}
