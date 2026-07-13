// Walmart enrich — one run, two phases sharing the extraction cache.
//   EXTRACT: scrape --since roster -> for each UNCACHED order, fetch+parse invoice, write PDF +
//            record to the cache immediately (resumable). --extract-only stops here.
//   SPLIT:   read cache -> match to Ramp charges -> build split + attach preview -> CSV audit.
// Dry-run by default; --live writes (split PATCH + receipt attach), capped, reversible via rollback.
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { withWalmartContext, isLoginWall } from './session';
import { scrapeOrderHistory } from './order-history';
import { fetchInvoice } from './order-fetch';
import { matchOrders } from './matcher';
import type { WalmartOrder } from './matcher';
import { loadStore } from './extraction-store';
import type { ExtractedOrder } from './extraction-store';
import { buildSplit } from '../amazon-enrich/split';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import { rampToken, patchSplit } from '../amazon-enrich/client';
import { attachReceipt } from './ramp-receipts';
import { getRampTransactions } from '../ramp-split-push/ramp-client';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import type { RampTxn, Entity } from '../ramp-split-push/types';

const OUT = 'scripts/walmart-enrich/out';
const CACHE = `${OUT}/extraction-cache.json`;
const PDF_DIR = 'scripts/walmart-enrich/.receipts_cache';
const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write receipts:write accounting:read';
const ENTITY: Entity = 'FL'; // Walmart card is on the FL entity (shared Sam's/Walmart/Amazon card)

interface Args { live: boolean; cap: number; since: string; maxPages: number; extractOnly: boolean }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | null => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1] : null; };
  return {
    live: a.includes('--live'),
    cap: Number(get('--cap') ?? '0') || 0,
    since: get('--since') ?? '2026-01-01',
    maxPages: Number(get('--pages') ?? '40') || 40,
    extractOnly: a.includes('--extract-only'),
  };
}
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toParsed(rec: ExtractedOrder): ParsedReceipt {
  return { layout: 'WMT', source: 'walmart', order: rec.orderId, glHint: null, items: rec.items, taxCents: rec.taxCents, shippingCents: rec.shippingCents, tipCents: rec.tipCents, parsedTotalCents: rec.parsedTotalCents };
}

// Already enriched by us = either a real multi-line split, OR a single line that carries a product
// memo (mirrors amazon-enrich/client.ts:isEnriched). priorLineItems is `unknown` on RampTxn — narrow
// it explicitly before inspecting shape. Erring toward "skip if memo present" is the safe direction
// (worst case we skip a txn, never re-split/re-attach one already enriched by a prior run).
function isTxnEnriched(priorLineItems: unknown): boolean {
  if (!Array.isArray(priorLineItems)) return false;
  const lines = priorLineItems as unknown[];
  if (lines.length > 1) return true;
  return lines.some((l) => {
    if (typeof l !== 'object' || l === null) return false;
    const memo = (l as { memo?: unknown }).memo;
    return typeof memo === 'string' && memo.trim().length > 0;
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
  const store = loadStore(CACHE);

  // ---- EXTRACT phase: fetch only orders not already in the cache (resumable, write-through) ----
  const roster = await scrapeOrderHistory(args.since, args.maxPages);
  const missing = roster.filter((o) => !store.has(o.orderId));
  console.log(`roster(since ${args.since}) ${roster.length} | cached ${roster.length - missing.length} | to-extract ${missing.length}`);
  let extracted = 0;
  const now = new Date().toISOString();
  if (missing.length > 0) {
    await withWalmartContext(async (page) => {
      for (const o of missing) {
        try {
          const f = await fetchInvoice(page, o.orderId);
          if (!f) continue; // fetch/parse fail -> left uncached, retried next run
          const pdfPath = `${PDF_DIR}/${o.orderId}.pdf`;
          writeFileSync(pdfPath, f.pdf);
          store.put({
            orderId: o.orderId, date: o.date, totalCents: o.totalCents,
            items: f.parsed.items, taxCents: f.parsed.taxCents, shippingCents: f.parsed.shippingCents,
            tipCents: f.parsed.tipCents, parsedTotalCents: f.parsed.parsedTotalCents, pdfPath, fetchedAt: now,
          });
          extracted++;
        } catch (e) {
          if (isLoginWall(page.url())) {
            console.error(`extract stopped at ${o.orderId}: session expired (login wall) — ${(e as Error).message}`);
            break; // session is dead; cache holds everything so far, re-bootstrap + re-run to resume
          }
          console.error(`extract skipped ${o.orderId}: ${(e as Error).message}`);
          continue; // transient per-order failure — left uncached, retried next run; keep extracting
        }
      }
    });
  }
  console.log(`extracted ${extracted} new (cache now ${store.all().length})`);

  // The lookup list the user reviews — one row per cached order.
  const index: string[] = ['order_id,date,total,item_count,parsed_total,reconciles'];
  for (const r of store.all()) index.push([r.orderId, r.date, (r.totalCents / 100).toFixed(2), r.items.length, (r.parsedTotalCents / 100).toFixed(2), r.parsedTotalCents === r.totalCents].map(csv).join(','));
  writeFileSync(`${OUT}/extraction-index.csv`, index.join('\n'));

  if (args.extractOnly) { console.log(`\nEXTRACT-ONLY: wrote ${OUT}/extraction-index.csv (${store.all().length}). No Ramp calls.`); return; }

  // ---- SPLIT phase: match cache -> Ramp charges, preview/write (never re-fetches Walmart) ----
  const token = await rampToken(ENTITY, args.live ? SCOPES_WRITE : SCOPES_READ);
  const gl = await buildGlIndex(ENTITY, token);
  const txns: RampTxn[] = (await getRampTransactions(ENTITY, token, 40))
    .filter((t) => /walmart/i.test(t.merchantName ?? '') && !isTxnEnriched(t.priorLineItems));

  const cachedOrders: WalmartOrder[] = store.all()
    .filter((r) => r.date >= args.since)
    .map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.totalCents }));
  const match = matchOrders(cachedOrders, txns);

  const preview: string[] = ['order_id,txn_id,amount,line_desc,split_amount,gl_name,confidence,coded,mode'];
  const aside: string[] = ['order_id,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; order_id: string; prior_line_items: unknown }[] = [];
  for (const o of match.ambiguous) aside.push([o.orderId, 'ambiguous_match', ''].map(csv).join(','));
  for (const o of match.unmatched) aside.push([o.orderId, 'no_ramp_match', `total=${(o.totalCents / 100).toFixed(2)}`].map(csv).join(','));

  let writes = 0;
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    if (rec.parsedTotalCents !== m.txn.amountCents) { aside.push([m.order.orderId, 'no_reconcile', `inv=${rec.parsedTotalCents} txn=${m.txn.amountCents}`].map(csv).join(',')); continue; }
    const built = buildSplit(toParsed(rec), m.txn.amountCents, gl);
    if (!built) { aside.push([m.order.orderId, 'build_fail', ''].map(csv).join(',')); continue; }

    const capped = args.live && args.cap > 0 && writes >= args.cap;
    const mode = args.live && !capped ? 'live' : 'dry_run';
    if (mode === 'live') {
      const res = await patchSplit(ENTITY, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
      if (res.status < 200 || res.status >= 300) { aside.push([m.order.orderId, 'write_fail', `HTTP ${res.status}`].map(csv).join(',')); continue; }
      const att = await attachReceipt(ENTITY, m.txn.id, readFileSync(rec.pdfPath), `walmart-${m.order.orderId}.pdf`, token);
      if (att.status < 200 || att.status >= 300) aside.push([m.order.orderId, 'attach_fail', `HTTP ${att.status}`].map(csv).join(','));
      writes++;
      rollback.push({ entity: ENTITY, txn_id: m.txn.id, order_id: m.order.orderId, prior_line_items: m.txn.priorLineItems });
    }
    for (const l of built.lines) {
      preview.push([m.order.orderId, m.txn.id, (m.txn.amountCents / 100).toFixed(2), l.desc, (l.amount / 100).toFixed(2), l.glName, l.confidence, l.coded, mode].map(csv).join(','));
    }
  }

  writeFileSync(`${OUT}/preview_splits.csv`, preview.join('\n'));
  writeFileSync(`${OUT}/set_aside.csv`, aside.join('\n'));
  // Append to the rollback audit trail — never clobber prior live runs' snapshots. Dedup by txn_id.
  if (rollback.length) {
    const path = `${OUT}/rollback.json`;
    const prior: typeof rollback = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seen = new Set(prior.map((r) => r.txn_id));
    const merged = [...prior, ...rollback.filter((r) => !seen.has(r.txn_id))];
    writeFileSync(path, JSON.stringify(merged, null, 2));
  }
  console.log(`\nMODE: ${args.live ? `LIVE (cap ${args.cap || '∞'}, ${writes} written)` : 'DRY-RUN (no writes)'}`);
  console.log(`confident ${match.confident.length} | ambiguous ${match.ambiguous.length} | unmatched ${match.unmatched.length}`);
  console.log(`Wrote ${OUT}/extraction-index.csv, ${OUT}/preview_splits.csv (${preview.length - 1}), ${OUT}/set_aside.csv (${aside.length - 1})${rollback.length ? `, ${OUT}/rollback.json (${rollback.length})` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
