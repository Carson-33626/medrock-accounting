'use client';

import { useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { RunsTab } from './RunsTab';
import { ReviewTab } from './ReviewTab';

type TabKey = 'runs' | 'review' | 'mappings';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'runs', label: 'Runs' },
  { key: 'review', label: 'Review' },
  { key: 'mappings', label: 'Mappings' },
];

/** `/payroll` client shell: tab nav (Runs / Review / Mappings) + page chrome. */
export function PayrollTabs() {
  const { darkMode } = useDarkMode();
  const [tab, setTab] = useState<TabKey>('runs');

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const headText = darkMode ? 'text-white' : 'text-slate-900';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Payroll</p>
          <h1 className={`text-2xl font-bold ${headText}`}>ADP Payroll Journal Entry</h1>
        </div>

        <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                tab === t.key
                  ? 'bg-blue-600 text-white'
                  : darkMode
                    ? 'text-slate-300 hover:bg-slate-700'
                    : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'runs' && <RunsTab />}
        {tab === 'review' && <ReviewTab />}
        {tab === 'mappings' && <ComingSoon cardBg={cardBg} subText={subText} label="Mappings" />}
      </div>
    </div>
  );
}

function ComingSoon({ cardBg, subText, label }: { cardBg: string; subText: string; label: string }) {
  return (
    <div className={`rounded-xl shadow-sm p-10 text-center ${cardBg}`}>
      <p className={`text-sm ${subText}`}>{label} tab — coming soon.</p>
    </div>
  );
}
