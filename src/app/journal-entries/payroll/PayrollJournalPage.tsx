'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useDarkMode } from '@/contexts/DarkModeContext';
import { PayrollsLanding } from '@/app/payroll/components/PayrollsLanding';
import { ReviewTab } from '@/app/payroll/components/ReviewTab';
import { PostPanel } from '@/app/payroll/components/PostPanel';

/**
 * The Payrolls page body: the landing list, and a specific draft's Review + Post
 * detail opened *in place* when a card is clicked, with a Back link to the list.
 * "Refine in Mappings →" now navigates to the Mappings page (its own route).
 */
export function PayrollJournalPage() {
  const { darkMode } = useDarkMode();
  const router = useRouter();
  const [selectedHeaderId, setSelectedHeaderId] = useState<number | null>(null);

  const handleOpen = useCallback((headerId: number) => setSelectedHeaderId(headerId), []);
  const handleBack = useCallback(() => setSelectedHeaderId(null), []);
  const handleNavigateToMappings = useCallback(
    (entity: string) => router.push(`/journal-entries/mappings?entity=${encodeURIComponent(entity)}`),
    [router],
  );

  if (selectedHeaderId !== null) {
    return (
      <>
        <button
          onClick={handleBack}
          className={`inline-flex items-center gap-1.5 text-sm font-medium ${
            darkMode ? 'text-blue-300 hover:text-blue-200' : 'text-blue-600 hover:text-blue-700'
          }`}
        >
          <ArrowLeft className="w-4 h-4" aria-hidden />
          Back to payrolls
        </button>
        <div className="space-y-6">
          <ReviewTab headerId={selectedHeaderId} onNavigateToMappings={handleNavigateToMappings} />
          <PostPanel headerId={selectedHeaderId} />
        </div>
      </>
    );
  }
  return <PayrollsLanding onOpen={handleOpen} />;
}
