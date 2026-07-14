// SPLIT phase for the CDP pipeline: read the extraction cache (built by run-cdp.ts), match each order to
// its un-receipted Ramp Walmart charge, generate an itemized receipt PDF, and preview/write the GL split
// + receipt attach. Dry-run by default (no writes, PDFs written to .receipts_cache for review); --live
// writes the split (PATCH) + attaches the PDF (POST /receipts), capped and reversible via rollback.json.
// Never re-fetches Walmart — purely cache -> Ramp.
//   npx tsx scripts/walmart-enrich/run-cdp-split.ts [--since 2024-01-01] [--ramp-pages 60] [--live] [--cap N]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { matchOrders } from './matcher';
import type { WalmartOrder } from './matcher';
import { loadStore } from './extraction-store';
import type { ExtractedOrder } from './extraction-store';
import { buildReceiptPdf } from './receipt-pdf';
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

interface Args { live: boolean; cap: number; since: string; rampPages: number }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | null => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1] : null; };
  return {
    live: a.includes('--live'),
    cap: Number(get('--cap') ?? '0') || 0,
    since: get('--since') ?? '2024-01-01',
    rampPages: Number(get('--ramp-pages') ?? '60') || 60,
  };
}
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toParsed(rec: ExtractedOrder): ParsedReceipt {
  return { layout: 'WMT', source: 'walmart', order: rec.orderId, glHint: null, items: rec.items, taxCents: rec.taxCents, shippingCents: rec.shippingCents, tipCents: rec.tipCents, parsedTotalCents: rec.parsedTotalCents };
}

// Already enriched by us = a real multi-line split OR a single line carrying a product memo (mirrors
// run.ts / amazon-enrich isEnriched). priorLineItems is `unknown` on RampTxn — narrow before inspecting.
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
  if (store.all().length === 0) throw new Error(`Empty cache at ${CACHE}. Run run-cdp.ts (EXTRACT) first.`);

  const token = await rampToken(ENTITY, args.live ? SCOPES_WRITE : SCOPES_READ);
  const gl = await buildGlIndex(ENTITY, token);
  const allTxns = await getRampTransactions(ENTITY, token, args.rampPages);
  const wmTxns: RampTxn[] = allTxns.filter((t) => /walmart/i.test(t.merchantName ?? ''));
  const openTxns: RampTxn[] = wmTxns.filter((t) => !isTxnEnriched(t.priorLineItems));
  const oldest = allTxns.length ? allTxns[allTxns.length - 1].date : 'n/a';
  console.log(`Ramp: fetched ${allTxns.length} txns (back to ${oldest}) | Walmart ${wmTxns.length} | un-receipted ${openTxns.length}`);
  if (allTxns.length >= args.rampPages * 100) console.log(`  NOTE: hit the ${args.rampPages}-page fetch limit — older txns may exist; raise --ramp-pages if coverage looks short.`);

  // Only reconciling orders are split-eligible (matcher joins on exact total; the reconcile gate below
  // also rejects any parsed total that disagrees with the charge).
  const cachedOrders: WalmartOrder[] = store.all()
    .filter((r) => r.date >= args.since && r.parsedTotalCents === r.totalCents && r.totalCents > 0)
    .map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.totalCents }));
  const match = matchOrders(cachedOrders, openTxns);

  const preview: string[] = ['order_id,txn_id,txn_date,amount,line_desc,split_amount,gl_name,confidence,coded,pdf,mode'];
  const aside: string[] = ['order_id,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; order_id: string; prior_line_items: unknown }[] = [];
  for (const o of match.ambiguous) aside.push([o.orderId, 'ambiguous_match', `total=${(o.totalCents / 100).toFixed(2)}`].map(csv).join(','));
  for (const o of match.unmatched) aside.push([o.orderId, 'no_ramp_match', `total=${(o.totalCents / 100).toFixed(2)}`].map(csv).join(','));

  let writes = 0, pdfsWritten = 0, attachFails = 0;
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    if (rec.parsedTotalCents !== m.txn.amountCents) { aside.push([m.order.orderId, 'no_reconcile', `inv=${rec.parsedTotalCents} txn=${m.txn.amountCents}`].map(csv).join(',')); continue; }
    const built = buildSplit(toParsed(rec), m.txn.amountCents, gl);
    if (!built) { aside.push([m.order.orderId, 'build_fail', ''].map(csv).join(',')); continue; }

    // Generate the itemized receipt PDF for this match (written to disk for review in every mode).
    const pdf = Buffer.from(await buildReceiptPdf(rec));
    const pdfPath = `${PDF_DIR}/walmart-${m.order.orderId}.pdf`;
    writeFileSync(pdfPath, pdf); pdfsWritten++;

    const capped = args.live && args.cap > 0 && writes >= args.cap;
    const mode = args.live && !capped ? 'live' : 'dry_run';
    if (mode === 'live') {
      const res = await patchSplit(ENTITY, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token);
      if (res.status < 200 || res.status >= 300) { aside.push([m.order.orderId, 'write_fail', `HTTP ${res.status}`].map(csv).join(',')); continue; }
      if (!m.txn.userId) { aside.push([m.order.orderId, 'attach_fail', 'no user_id on txn'].map(csv).join(',')); attachFails++; }
      else {
        const att = await attachReceipt(ENTITY, m.txn.id, pdf, `walmart-${m.order.orderId}.pdf`, token, m.txn.userId, `walmart-receipt-${m.order.orderId}`);
        if (att.status < 200 || att.status >= 300) { aside.push([m.order.orderId, 'attach_fail', `HTTP ${att.status}`].map(csv).join(',')); attachFails++; }
      }
      writes++;
      rollback.push({ entity: ENTITY, txn_id: m.txn.id, order_id: m.order.orderId, prior_line_items: m.txn.priorLineItems });
    }
    for (const l of built.lines) {
      preview.push([m.order.orderId, m.txn.id, m.txn.date, (m.txn.amountCents / 100).toFixed(2), l.desc, (l.amount / 100).toFixed(2), l.glName, l.confidence, l.coded, pdfPath, mode].map(csv).join(','));
    }
  }

  writeFileSync(`${OUT}/preview_splits.csv`, preview.join('\n'));
  writeFileSync(`${OUT}/set_aside.csv`, aside.join('\n'));
  if (rollback.length) {
    const path = `${OUT}/rollback.json`;
    const prior: typeof rollback = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seen = new Set(prior.map((r) => r.txn_id));
    writeFileSync(path, JSON.stringify([...prior, ...rollback.filter((r) => !seen.has(r.txn_id))], null, 2));
  }
  console.log(`\nMODE: ${args.live ? `LIVE (cap ${args.cap || '∞'}, ${writes} written, ${attachFails} attach-fail)` : 'DRY-RUN (no writes; PDFs generated for review)'}`);
  console.log(`eligible orders ${cachedOrders.length} | confident ${match.confident.length} | ambiguous ${match.ambiguous.length} | unmatched ${match.unmatched.length} | PDFs ${pdfsWritten}`);
  console.log(`Wrote ${OUT}/preview_splits.csv (${preview.length - 1} lines), ${OUT}/set_aside.csv (${aside.length - 1})${rollback.length ? `, ${OUT}/rollback.json (+${rollback.length})` : ''}. PDFs in ${PDF_DIR}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
