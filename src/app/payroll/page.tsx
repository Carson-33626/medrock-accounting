import { redirect } from 'next/navigation';
import { journalEntryHrefForTab } from '@/app/journal-entries/routes';

export const dynamic = 'force-dynamic';

/**
 * `/payroll` is retired — each journal-entry type is its own page under
 * /journal-entries (Carson, 2026-09-15). Old links and bookmarks still land:
 * `?tab=` picks the page, `?month=` and `?entity=` ride across.
 */
export default async function PayrollRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = typeof q.tab === 'string' ? q.tab : null;
  const carried = new URLSearchParams();
  for (const key of ['month', 'entity'] as const) {
    const v = q[key];
    if (typeof v === 'string' && v !== '') carried.set(key, v);
  }
  const qs = carried.toString();
  redirect(`${journalEntryHrefForTab(tab)}${qs ? `?${qs}` : ''}`);
}
