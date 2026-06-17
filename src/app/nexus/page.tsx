'use client';

import { useDarkMode } from '@/contexts/DarkModeContext';
import NexusExposure from '@/components/NexusExposure';

export const dynamic = 'force-dynamic';

export default function NexusPage() {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Company</p>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Economic-Nexus Exposure
          </h1>
          <p className={`text-sm mt-2 ${subText}`}>
            Where MedRock&apos;s ship-to sales stand against each state&apos;s economic-nexus threshold — the data side of
            the CPA nexus study. Built from the live sales-tax feed (<code>source.sales_tax_report</code>) and the
            verified 2026 threshold table.
          </p>
        </div>
        <NexusExposure />
      </div>
    </div>
  );
}
