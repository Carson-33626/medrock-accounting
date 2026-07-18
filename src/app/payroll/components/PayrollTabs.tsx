'use client';

import { useCallback, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { PayrollsLanding } from './PayrollsLanding';
import { ReviewTab } from './ReviewTab';
import { MappingsTab } from './MappingsTab';
import { PostPanel } from './PostPanel';
import { AccrualAllocationNotes } from './AccrualAllocationNotes';

type View = 'payrolls' | 'mappings';

const TABS: Array<{ key: View; label: string }> = [
  { key: 'payrolls', label: 'Payrolls' },
  { key: 'mappings', label: 'Mappings' },
];

/**
 * `/payroll` client shell. Two primary destinations — Payrolls (the landing list) and
 * Mappings. A specific draft's Review + Post detail opens *in place* when a payroll card
 * is clicked (not as a tab), with a Back link to the list.
 */
export function PayrollTabs() {
  const { darkMode } = useDarkMode();
  const [view, setView] = useState<View>('payrolls');
  const [selectedHeaderId, setSelectedHeaderId] = useState<number | null>(null);
  const [mappingsEntity, setMappingsEntity] = useState<string | undefined>(undefined);

  // Click a payroll card → open its Review/Post detail.
  const handleOpen = useCallback((headerId: number) => {
    setSelectedHeaderId(headerId);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedHeaderId(null);
  }, []);

  // "Refine in Mappings →" from the Review detail: jump to Mappings, pre-selecting the entity.
  const handleNavigateToMappings = useCallback((entity: string) => {
    setMappingsEntity(entity);
    setSelectedHeaderId(null);
    setView('mappings');
  }, []);

  const switchTab = useCallback((next: View) => {
    setSelectedHeaderId(null);
    setView(next);
  }, []);

  const pageBg = darkMode ? 'bg-slate-900' : 'bg-slate-50';
  const cardBg = darkMode ? 'bg-slate-800 text-slate-100' : 'bg-white text-slate-900';
  const subText = darkMode ? 'text-slate-400' : 'text-slate-500';
  const headText = darkMode ? 'text-white' : 'text-slate-900';
  const border = darkMode ? 'border-slate-700' : 'border-slate-200';

  const inDetail = selectedHeaderId !== null;

  return (
    <div className={`min-h-screen ${pageBg} p-4 md:p-8`}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${subText}`}>Payroll</p>
          <h1 className={`text-2xl font-bold ${headText}`}>ADP Payroll Journal Entry</h1>
        </div>

        <AccrualAllocationNotes darkMode={darkMode} />

        {inDetail ? (
          <button
            onClick={handleBack}
            className={`inline-flex items-center gap-1.5 text-sm font-medium ${
              darkMode ? 'text-blue-300 hover:text-blue-200' : 'text-blue-600 hover:text-blue-700'
            }`}
          >
            <ArrowLeft className="w-4 h-4" aria-hidden />
            Back to payrolls
          </button>
        ) : (
          <div className={`inline-flex rounded-xl border p-1 ${cardBg} ${border}`}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => switchTab(t.key)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  view === t.key
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
        )}

        {inDetail ? (
          <div className="space-y-6">
            <ReviewTab headerId={selectedHeaderId} onNavigateToMappings={handleNavigateToMappings} />
            <PostPanel headerId={selectedHeaderId} />
          </div>
        ) : view === 'payrolls' ? (
          <PayrollsLanding onOpen={handleOpen} />
        ) : (
          <MappingsTab initialEntity={mappingsEntity} />
        )}
      </div>
    </div>
  );
}
