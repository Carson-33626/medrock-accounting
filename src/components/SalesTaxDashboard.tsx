'use client';

import { useState } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import SalesTaxFL from './SalesTaxFL';

type StateTab = 'FL' | 'GA' | 'NC' | 'TX';

interface TabDef {
  key: StateTab;
  label: string;
  status: 'live' | 'script' | 'planned';
}

const TABS: TabDef[] = [
  { key: 'FL', label: 'Florida', status: 'live' },
  { key: 'GA', label: 'Georgia', status: 'script' },
  { key: 'NC', label: 'North Carolina', status: 'script' },
  { key: 'TX', label: 'Texas', status: 'planned' },
];

export default function SalesTaxDashboard() {
  const { darkMode } = useDarkMode();
  const [active, setActive] = useState<StateTab>('FL');

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const rowBorder = darkMode ? 'border-slate-700' : 'border-slate-200';
  const inactiveTab = darkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>Sales Tax</h1>
          <p className={`text-sm ${subText}`}>State sales &amp; use tax filing prep, generated from the LifeFile feed.</p>
        </div>

        {/* Tab bar */}
        <div className={`flex gap-1 border-b ${rowBorder}`}>
          {TABS.map((t) => {
            const isActive = active === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActive(t.key)}
                className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? (darkMode ? 'text-white' : 'text-slate-900') : inactiveTab
                }`}
              >
                {t.label}
                {t.status !== 'live' && (
                  <span
                    className={`ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      darkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {t.status === 'script' ? 'script' : 'soon'}
                  </span>
                )}
                {isActive && (
                  <span
                    className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full"
                    style={{ backgroundColor: '#5e3b8d' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Panel */}
        {active === 'FL' && <SalesTaxFL />}
        {active === 'GA' && (
          <StatePlaceholder
            title="Georgia — annual filing"
            note="Filed successfully for 2025 via scripts/process_ga_tax_report.py (county-level summary for GTC entry). Not yet migrated to this page — the LifeFile feed already carries GA county + FIPS (98.5% resolved), so a web generator like Florida's is the next step."
          />
        )}
        {active === 'NC' && (
          <StatePlaceholder
            title="North Carolina — monthly filing (due the 20th)"
            note="Filed via scripts/process_nc_tax_report.py (E-500 + E-536 schedule, Article 44 counties, transit tax). Not yet on this page — can be moved onto the feed like Florida."
          />
        )}
        {active === 'TX' && (
          <StatePlaceholder
            title="Texas — annual filing"
            note="Not yet built. The feed carries TX transactions (from Feb 2026); a generator can be added when Texas filing is scoped."
          />
        )}
      </div>
    </div>
  );
}

function StatePlaceholder({ title, note }: { title: string; note: string }) {
  const { darkMode } = useDarkMode();
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className={`rounded-xl shadow-sm p-6 ${cardBg}`}>
      <p className="text-sm font-semibold mb-2">{title}</p>
      <p className={`text-sm ${subText}`}>{note}</p>
    </div>
  );
}
