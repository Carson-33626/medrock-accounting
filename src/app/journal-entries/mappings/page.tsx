import type { Metadata } from 'next';
import { requireManager } from '@/lib/auth';
import { JournalEntriesShell } from '../JournalEntriesShell';
import { MappingsTab } from '@/app/payroll/components/MappingsTab';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Payroll Mappings — MedRock Accounting',
  description: 'ADP column and employee mappings that drive the payroll journal entries',
};

/** `?entity=` pre-selects the company ("Refine in Mappings →" from a payroll review). */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireManager();
  const q = await searchParams;
  const entity = typeof q.entity === 'string' ? q.entity : undefined;
  return (
    <JournalEntriesShell title="Payroll Mappings" notesView="mappings">
      <MappingsTab initialEntity={entity} />
    </JournalEntriesShell>
  );
}
