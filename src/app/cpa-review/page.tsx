'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';

export const dynamic = 'force-dynamic';

/**
 * Pruned 2026-09-15 (Carson: "remove everything that is done, i don't want any
 * archive, they have the google doc for the current workload"). Every topic that
 * lived here — use-tax source, the Texas method / sourcing / permit date, the TN
 * SLS-450 amend question, the nexus study input, the 01-799 election, the TN
 * Gross method — has been decided. The running workload is the accounting team's
 * weekly Google Doc; phase two of this page is still to be designed.
 */
const WORKING_DOC_URL = 'https://docs.google.com/document/d/1a0--qd2EJKffSNrYMLxImhfL13E78MHb6Jc6iW6qWNU/edit';

export default function CompanyCpaReviewPage() {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';

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
          <p className="text-sm font-semibold mb-2">No open topics</p>
          <p className={`text-sm ${subText}`}>
            Everything previously queued here for CPA review has been decided. The accounting team&rsquo;s
            current workload lives in the weekly working doc, not on this page.
          </p>
          <a
            href={WORKING_DOC_URL}
            target="_blank"
            rel="noreferrer"
            className={`inline-block mt-3 text-sm font-medium underline ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}
          >
            Open the accounting working doc ↗
          </a>
        </div>
      </div>
    </div>
  );
}
