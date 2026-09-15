import type { Metadata } from 'next';
import { requireManager } from '@/lib/auth';
import { JournalEntriesShell } from '../JournalEntriesShell';
import { PayrollJournalPage } from './PayrollJournalPage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Payroll Journal — MedRock Accounting',
  description: 'Draft, review, and post per-entity payroll journal entries',
};

export default async function Page() {
  await requireManager();
  return (
    <JournalEntriesShell title="Payroll Journal" notesView="payrolls">
      <PayrollJournalPage />
    </JournalEntriesShell>
  );
}
