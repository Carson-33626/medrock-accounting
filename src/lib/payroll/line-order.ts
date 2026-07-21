/**
 * Canonical display/sort order for JE lines. Without this, lines come out in the builder's
 * bucket-first-appearance order (arbitrary, data-driven) — which buried the `Accounting Wages`
 * line far below `Admin Wages` on the same account so the accountant never scrolled to it.
 *
 * Sorting by account name then memo groups every line of one account adjacently (Admin/Accounting
 * wages sit together), then by department/class for a stable total order. Structural key type so
 * both the client ReviewTab (local line mirror) and server build-je/je-export can share it without
 * pulling any server-only module into the client bundle.
 */
export interface LineOrderKey {
  accountName: string;
  memo: string | null;
  departmentName: string | null;
  className: string | null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareJournalLines(a: LineOrderKey, b: LineOrderKey): number {
  return (
    cmp(a.accountName, b.accountName) ||
    cmp(a.memo ?? '', b.memo ?? '') ||
    cmp(a.departmentName ?? '', b.departmentName ?? '') ||
    cmp(a.className ?? '', b.className ?? '')
  );
}
