'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';

/** Page chrome shared by every per-state sales-tax page. */
export default function SalesTaxShell({ state, children }: { state: string; children: React.ReactNode }) {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Sales Tax — {state}
          </h1>
          <p className={`text-sm ${subText}`}>State sales &amp; use tax filing prep, generated from the LifeFile feed.</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatePlaceholder({ title, note }: { title: string; note: string }) {
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
