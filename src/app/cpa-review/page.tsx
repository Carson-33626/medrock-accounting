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
            about filing. First candidate: the <strong>economic-nexus signal</strong> (where each location ships,
            out-of-state volume by state), which informs whether any new state registration/filing obligation exists.
          </p>
          <p className={`text-sm mt-3 ${subText}`}>
            This page is a placeholder for now and will be expanded later.
          </p>
        </div>
      </div>
    </div>
  );
}
