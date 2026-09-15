import type { Metadata } from 'next';
import { requireManager } from '@/lib/auth';
import { JournalEntriesShell } from '../JournalEntriesShell';
import { InventoryCloseTab } from '@/app/payroll/components/InventoryCloseTab';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Inventory Month-End Close — MedRock Accounting',
  description: 'Inventory close journal entries: FIFO target vs the QuickBooks book balance by category',
};

/** `?month=YYYY-MM` is the return trip from the Point-in-Time page. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireManager();
  const q = await searchParams;
  const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : undefined;
  return (
    <JournalEntriesShell title="Inventory Month-End Close">
      <InventoryCloseTab initialMonth={month} />
    </JournalEntriesShell>
  );
}
