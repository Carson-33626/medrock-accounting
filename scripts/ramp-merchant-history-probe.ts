// READ-ONLY: dump the shape of a coded Ramp txn's accounting fields so we can build a merchant->GL
// history poll. Prints the first few txns that carry accounting_field_selections / line-item GL.
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { rampToken, rampGet } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const ENTITY: Entity = 'FL';

interface Page { data: Record<string, unknown>[]; page?: { next?: string } }

async function main(): Promise<void> {
  const token = await rampToken(ENTITY, 'transactions:read accounting:read');
  const res: { status: number; body: Page } = await rampGet<Page>(ENTITY, '/transactions?page_size=100&order_by_date_desc=true', token);
  const rows = res.body.data ?? [];
  console.log(`pulled ${rows.length}`);
  let shown = 0;
  for (const t of rows) {
    const afs = t['accounting_field_selections'];
    const li = t['line_items'];
    const hasAfs = Array.isArray(afs) && afs.length > 0;
    const hasLiGl = Array.isArray(li) && li.some((l) => l && typeof l === 'object' && Array.isArray((l as Record<string, unknown>)['accounting_field_selections']) && ((l as Record<string, unknown>)['accounting_field_selections'] as unknown[]).length > 0);
    if (!hasAfs && !hasLiGl) continue;
    console.log(`\n=== txn ${t['id']} | ${t['merchant_name']} | $${t['amount']} ===`);
    console.log('accounting_field_selections:', JSON.stringify(afs, null, 1));
    if (hasLiGl) console.log('line_items[0]:', JSON.stringify((li as unknown[])[0], null, 1));
    console.log('accounting_categories:', JSON.stringify(t['accounting_categories']));
    if (++shown >= 3) break;
  }
  if (shown === 0) console.log('no coded txns on first page');
}
main().catch((e) => { console.error(e); process.exit(1); });
