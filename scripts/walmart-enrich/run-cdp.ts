// EXTRACT runner (CDP method): attach to the user's real Chrome, enumerate the FULL order roster by
// paging the purchase-history "Next" chevron, then fetch each uncached order's __NEXT_DATA__ JSON, map to
// ParsedReceipt, and write through to the extraction cache.
// Extract-only + dry: no Ramp calls, no writes anywhere but the local cache + a reviewable index CSV.
// Resumable (write-through) and idempotent (skips already-cached orders).
//   npx tsx scripts/walmart-enrich/run-cdp.ts [--since 2026-01-01] [--pages 500]
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { withWalmartPage } from './cdp-session';
import { scrapeRoster } from './cdp-roster';
import { fetchOrderJson } from './cdp-fetch';
import { loadStore } from './extraction-store';

const OUT = 'scripts/walmart-enrich/out';
const CACHE = `${OUT}/extraction-cache.json`;

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const since = arg('--since', '2026-01-01');
  const maxPages = Number(arg('--pages', '500')) || 500;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const store = loadStore(CACHE);
  const now = new Date().toISOString();

  const stats = await withWalmartPage(async (page) => {
    const roster = await scrapeRoster(page, { since, maxPages });
    // The roster stops at the `since` cutoff, but the boundary page can carry a few older orders — filter.
    const inWindow = roster.filter((r) => !r.date || r.date >= since);
    console.log(`roster: ${roster.length} order(s) enumerated, ${inWindow.length} on/after ${since}`);
    const missing = inWindow.filter((r) => !store.has(r.orderId));
    console.log(`cached ${inWindow.length - missing.length} | to-fetch ${missing.length}`);

    let extracted = 0, skipped = 0, reconMismatch = 0, noItems = 0, unsettled = 0;
    for (const r of missing) {
      let f: Awaited<ReturnType<typeof fetchOrderJson>>;
      try { f = await fetchOrderJson(page, r.orderId); }
      catch (e) { console.error(`stop at ${r.orderId}: ${(e as Error).message}`); break; }
      if (!f) { console.error(`  ${r.orderId}: no parseable items`); noItems++; continue; }
      if (f.date && f.date < since) { console.log(`  ${r.orderId}: ${f.date} < ${since} — skip`); skipped++; continue; }
      if (f.chargeCents === 0) { console.log(`  ${r.orderId}: $0 total (unsettled/pending) — skip, retry later`); unsettled++; continue; }
      const recon = f.parsed.parsedTotalCents === f.chargeCents;
      if (!recon) reconMismatch++;
      store.put({
        orderId: f.orderId, date: f.date, totalCents: f.chargeCents,
        items: f.parsed.items, taxCents: f.parsed.taxCents, shippingCents: f.parsed.shippingCents,
        tipCents: f.parsed.tipCents, parsedTotalCents: f.parsed.parsedTotalCents, pdfPath: '', fetchedAt: now,
      });
      extracted++;
      console.log(`  ${f.orderId} ${f.date} items=${f.parsed.items.length} parsed=$${(f.parsed.parsedTotalCents / 100).toFixed(2)} charge=$${(f.chargeCents / 100).toFixed(2)} ${recon ? 'OK' : 'RECON-MISMATCH'}`);
    }
    return { extracted, skipped, reconMismatch, noItems, unsettled, roster: roster.length };
  });

  const idx = ['order_id,date,total,items,parsed_total,reconciles'];
  for (const r of store.all()) {
    idx.push([r.orderId, r.date, (r.totalCents / 100).toFixed(2), String(r.items.length), (r.parsedTotalCents / 100).toFixed(2), String(r.parsedTotalCents === r.totalCents)].join(','));
  }
  writeFileSync(`${OUT}/extraction-index.csv`, idx.join('\n'));
  console.log(`\nEXTRACT done: +${stats.extracted} new | ${stats.skipped} before ${since} | ${stats.unsettled} unsettled($0) | ${stats.reconMismatch} reconcile-mismatch | ${stats.noItems} no-items. cache=${store.all().length}. wrote ${OUT}/extraction-index.csv`);
}
main().catch((e) => { console.error(e); process.exit(1); });
