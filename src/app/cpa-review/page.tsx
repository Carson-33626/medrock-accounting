'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';

export const dynamic = 'force-dynamic';

export default function CompanyCpaReviewPage() {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const pendingBg = darkMode
    ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
    : 'bg-amber-50 border-amber-200 text-amber-900';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Company</p>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Company CPA Review
          </h1>
          <div className={`mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${pendingBg}`}>
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
            Pending build out
          </div>
        </div>

        <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
          <p className="text-sm font-semibold mb-2">What lands here</p>
          <p className={`text-sm ${subText}`}>
            Company-level review material for the CPA — kept out of the per-state tax pages so those stay strictly
            about filing. The page itself is a placeholder; the topics below are the open items queued for review.
          </p>
        </div>

        <div className="space-y-4">
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Open topics for the CPA</p>

          <Topic
            cardBg={cardBg}
            subText={subText}
            tag="Texas"
            title="Taxable-sales method change (Texas returns)"
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
          >
            Both Texas Sales &amp; Use Tax permits appear effective <strong>Feb 1, 2026</strong> (neither entity has any
            January 2026 TX rows; both Q1 returns covered Feb+Mar only). The generator floors at 2026-02 and excludes
            January. <strong>Confirm January 2026 Texas sales carried no filing obligation.</strong>
          </Topic>

          <Topic
            cardBg={cardBg}
            subText={subText}
            tag="Nexus"
            title="Economic-nexus signal (post-Wayfair)"
          >
            Where each location ships and out-of-state volume by state — informs whether any new state
            registration/filing obligation exists beyond FL/TX/TN. Data can be sourced from the per-location ship-to feed
            once built out here.
          </Topic>
        </div>
      </div>
    </div>
  );
}

function Topic({
  cardBg,
  subText,
  tag,
  title,
  children,
}: {
  cardBg: string;
  subText: string;
  tag: string;
  title: string;
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
    </div>
  );
}
