'use client';

import type { ReactNode } from 'react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { AccrualAllocationNotes } from '@/app/payroll/components/AccrualAllocationNotes';

export type JournalEntriesNotesView = 'payrolls' | 'endofmonth' | 'mappings';

/**
 * The frame every Journal Entries page sits in: page background, the
 * "Journal Entries" eyebrow, the page title, and the reference-notes banner the
 * old `/payroll` shell showed for payroll / end-of-month / mappings (never for
 * the inventory close). Carson, 2026-09-15: the top pill selector is gone — each
 * entry type is its own page, reached from the left nav.
 */
export function JournalEntriesShell({
  title,
  notesView,
  children,
}: {
  title: string;
  /** Which notes banner to show; omit for none (inventory close). */
  notesView?: JournalEntriesNotesView;
  children: ReactNode;
}) {
  const { darkMode } = useDarkMode();
  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const headText = darkMode ? 'text-white' : 'text-slate-900';
  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Journal Entries</p>
          <h1 className={`text-2xl font-bold ${headText}`}>{title}</h1>
        </div>
        {notesView && <AccrualAllocationNotes darkMode={darkMode} view={notesView} />}
        {children}
      </div>
    </div>
  );
}
