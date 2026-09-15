/**
 * The Journal Entries pages — one route per entry type. Shared by the sidebar
 * group, the `/payroll` redirect and any page that links across.
 */
export const JOURNAL_ENTRY_ROUTES = [
  { key: 'payrolls', href: '/journal-entries/payroll', label: 'Payrolls', title: 'Payroll Journal' },
  { key: 'endofmonth', href: '/journal-entries/end-of-month', label: 'End of Month', title: 'End of Month Allocation' },
  { key: 'inventoryclose', href: '/journal-entries/inventory-close', label: 'Inventory Close', title: 'Inventory Month-End Close' },
  { key: 'mappings', href: '/journal-entries/mappings', label: 'Mappings', title: 'Payroll Mappings' },
] as const;

export type JournalEntryRouteKey = (typeof JOURNAL_ENTRY_ROUTES)[number]['key'];

export const JOURNAL_ENTRIES_PREFIX = '/journal-entries';

/** The old `/payroll?tab=<key>` deep link → its new page. Unknown or missing tab → Payrolls. */
export function journalEntryHrefForTab(tab: string | null | undefined): string {
  const match = JOURNAL_ENTRY_ROUTES.find((r) => r.key === tab);
  return (match ?? JOURNAL_ENTRY_ROUTES[0]).href;
}
