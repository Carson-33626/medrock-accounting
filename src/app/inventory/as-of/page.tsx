import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The "Point-in-Time Inventory Value" page merged into /inventory, which now
 * carries the month picker and restates everything from it.
 *
 * Kept as a redirect rather than deleted: this path is bookmarked, and the
 * inventory-close tab has linked here. The query string carries the whole view
 * (month, location, category, from), so forwarding it lands on exactly the same
 * figures the old link pointed at.
 */
export default async function InventoryAsOfPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') q.set(key, value);
    else if (Array.isArray(value) && value.length > 0) q.set(key, value[0]);
  }
  const query = q.toString();
  redirect(query ? `/inventory?${query}` : '/inventory');
}
