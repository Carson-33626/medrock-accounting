// Re-fetch cached orders that did NOT reconcile (parsedTotal != total) or have a $0 (unsettled) total,
// re-parsing them with the current order-json logic. Use after a parser fix so a full re-backfill isn't
// needed — only the ~broken subset is re-fetched. Updates reconciled entries in place; drops entries
// that are still $0 (genuinely unsettled) so a later run retries them. Dry: only touches the local cache.
//   npx tsx scripts/walmart-enrich/refetch-unreconciled.ts
import { withWalmartPage } from './cdp-session';
import { fetchOrderJson } from './cdp-fetch';
import { loadStore } from './extraction-store';

const CACHE = 'scripts/walmart-enrich/out/extraction-cache.json';

async function main(): Promise<void> {
  const store = loadStore(CACHE);
  const now = new Date().toISOString();
  const broken = store.all().filter((r) => r.totalCents === 0 || r.parsedTotalCents !== r.totalCents);
  console.log(`cache=${store.all().length} | to re-fetch (mismatch or $0): ${broken.length}`);

  const res = await withWalmartPage(async (page) => {
    let fixed = 0, stillMismatch = 0, dropped = 0, failed = 0;
    for (const r of broken) {
      let f: Awaited<ReturnType<typeof fetchOrderJson>>;
      try { f = await fetchOrderJson(page, r.orderId); }
      catch (e) { console.error(`stop at ${r.orderId}: ${(e as Error).message}`); break; }
      if (!f) { console.error(`  ${r.orderId}: no parseable items`); failed++; continue; }
      if (f.chargeCents === 0) { store.remove(r.orderId); dropped++; console.log(`  ${r.orderId}: still $0 — dropped (unsettled)`); continue; }
      const recon = f.parsed.parsedTotalCents === f.chargeCents;
      store.put({
        orderId: f.orderId, date: f.date, totalCents: f.chargeCents,
        items: f.parsed.items, taxCents: f.parsed.taxCents, shippingCents: f.parsed.shippingCents,
        tipCents: f.parsed.tipCents, parsedTotalCents: f.parsed.parsedTotalCents, pdfPath: '', fetchedAt: now,
      });
      if (recon) { fixed++; console.log(`  ${f.orderId} ${f.date} parsed=$${(f.parsed.parsedTotalCents / 100).toFixed(2)} charge=$${(f.chargeCents / 100).toFixed(2)} FIXED`); }
      else { stillMismatch++; console.log(`  ${f.orderId} ${f.date} parsed=$${(f.parsed.parsedTotalCents / 100).toFixed(2)} charge=$${(f.chargeCents / 100).toFixed(2)} still-mismatch (Δ$${((f.chargeCents - f.parsed.parsedTotalCents) / 100).toFixed(2)})`); }
    }
    return { fixed, stillMismatch, dropped, failed };
  });

  const remaining = store.all().filter((r) => r.parsedTotalCents !== r.totalCents).length;
  console.log(`\nRE-FETCH done: ${res.fixed} fixed | ${res.stillMismatch} still-mismatch | ${res.dropped} dropped($0) | ${res.failed} no-items. cache=${store.all().length}, non-reconciling now=${remaining}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
