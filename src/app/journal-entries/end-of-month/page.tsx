import type { Metadata } from 'next';
import { requireManager } from '@/lib/auth';
import { JournalEntriesShell } from '../JournalEntriesShell';
import { EndOfMonthTab } from '@/app/payroll/components/EndOfMonthTab';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'End of Month Allocation — MedRock Accounting',
  description: 'Month-end allocation journal entries: the Allocate pool split across entities',
};

export default async function Page() {
  await requireManager();
  return (
    <JournalEntriesShell title="End of Month Allocation" notesView="endofmonth">
      <EndOfMonthTab />
    </JournalEntriesShell>
  );
}
