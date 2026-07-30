// SPLIT phase for the CDP pipeline: read the extraction cache (built by the retailer's CDP extractor),
// match each order to its open Ramp charge, generate an itemized receipt PDF, and preview/write the GL
// split + receipt attach. Dry-run by default (no writes, PDFs written to .receipts_cache for review);
// --live writes the split (PATCH) + attaches the PDF (POST /receipts), capped and reversible via
// rollback.json. Never re-fetches the retailer — purely cache -> Ramp.
//
// Runs across ALL entities. It was pinned to FL until 2026-07-30, which silently hid the bulk of the work:
// only 4 of 55 open Walmart txns were FL (42 TN, 9 TX), so 37 already-cached orders could never match and
// were logged as `no_ramp_match`. Orders are pooled and matched ONCE against every entity's transactions,
// so a single pass claims each order and each txn at most once; the winning txn's own entity selects the
// token and GL index used to write it.
//   npx tsx scripts/walmart-enrich/run-cdp-split.ts [--retailer walmart|sams] [--entity FL] [--since 2024-01-01] [--ramp-pages 60] [--live] [--cap N]
import './../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { matchOrders } from './matcher';
import type { WalmartOrder } from './matcher';
import { loadStore } from './extraction-store';
import type { ExtractedOrder } from './extraction-store';
import { buildReceiptPdf } from './receipt-pdf';
import { decideWrites } from './write-gate';
import { resolveProfile } from './retailer-profile';
import type { RetailerProfile } from './retailer-profile';
import { buildSplit } from '../amazon-enrich/split';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import { rampToken, patchSplit } from '../amazon-enrich/client';
import { attachReceipt, receiptIdempotencyKey } from './ramp-receipts';
import { getRampTransactions } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';
import type { RampTxn, Entity } from '../ramp-split-push/types';

const SCOPES_READ = 'transactions:read accounting:read';
const SCOPES_WRITE = 'transactions:read transactions:write receipts:write accounting:read';

interface Args { live: boolean; cap: number; since: string; rampPages: number; entities: Entity[]; profile: RetailerProfile }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | null => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1] : null; };
  const entityArg = get('--entity');
  const entities: Entity[] = entityArg ? entityArg.split(',').map((s) => s.trim()).filter(Boolean) as Entity[] : [...ALL_ENTITIES];
  for (const e of entities) if (!ALL_ENTITIES.includes(e)) throw new Error(`Unknown --entity ${e as string} (expected FL, TN, or TX)`);
  return {
    live: a.includes('--live'),
    cap: Number(get('--cap') ?? '0') || 0,
    since: get('--since') ?? '2024-01-01',
    rampPages: Number(get('--ramp-pages') ?? '60') || 60,
    entities,
    profile: resolveProfile(get('--retailer') ?? 'walmart'),
  };
}
function csv(v: unknown): string { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toParsed(rec: ExtractedOrder, profile: RetailerProfile): ParsedReceipt {
  return { layout: 'WMT', source: profile.key, order: rec.orderId, glHint: null, items: rec.items, taxCents: rec.taxCents, shippingCents: rec.shippingCents, tipCents: rec.tipCents, parsedTotalCents: rec.parsedTotalCents };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { profile } = args;
  const OUT = profile.outDir;
  const PDF_DIR = profile.pdfDir;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
  const store = loadStore(profile.cacheFile);
  if (store.all().length === 0) throw new Error(`Empty cache at ${profile.cacheFile}. Run the ${profile.label} EXTRACT first.`);

  // Per-entity write context; the pooled match picks one by the winning txn's entity.
  const token: Record<string, string> = {};
  const glByEntity: Record<string, GlIndex> = {};
  const openTxns: RampTxn[] = [];
  let fetched = 0, merchantTxns = 0;
  for (const e of args.entities) {
    token[e] = await rampToken(e, args.live ? SCOPES_WRITE : SCOPES_READ);
    glByEntity[e] = await buildGlIndex(e, token[e]);
    const all = await getRampTransactions(e, token[e], args.rampPages);
    const mine = all.filter((t) => profile.merchantPattern.test(t.merchantName ?? ''));
    // Keep every merchant txn that still permits SOME write; decideWrites is re-consulted per match to
    // choose which writes, and its blockedReason lands in set_aside.
    const open = mine.filter((t) => decideWrites(t).blockedReason === null);
    fetched += all.length; merchantTxns += mine.length;
    openTxns.push(...open);
    console.log(`  [${e}] fetched ${all.length} txns | ${profile.label} ${mine.length} | writable ${open.length}`);
    if (all.length >= args.rampPages * 100) console.log(`  [${e}] NOTE: hit the ${args.rampPages}-page fetch limit — raise --ramp-pages if coverage looks short.`);
  }
  console.log(`Ramp: ${fetched} txns across ${args.entities.join('/')} | ${profile.label} ${merchantTxns} | writable ${openTxns.length}`);

  // Only reconciling orders are split-eligible (matcher joins on exact total; the reconcile gate below
  // also rejects any parsed total that disagrees with the charge).
  const cachedOrders: WalmartOrder[] = store.all()
    .filter((r) => r.date >= args.since && r.parsedTotalCents === r.totalCents && r.totalCents > 0)
    .map((r) => ({ orderId: r.orderId, date: r.date, totalCents: r.totalCents }));
  const match = matchOrders(cachedOrders, openTxns);

  const preview: string[] = ['order_id,entity,txn_id,txn_date,amount,line_desc,split_amount,gl_name,confidence,coded,pdf,mode'];
  const aside: string[] = ['order_id,reason,detail'];
  const rollback: { entity: Entity; txn_id: string; order_id: string; prior_line_items: unknown }[] = [];
  for (const o of match.ambiguous) aside.push([o.orderId, 'ambiguous_match', `total=${(o.totalCents / 100).toFixed(2)}`].map(csv).join(','));
  for (const o of match.unmatched) aside.push([o.orderId, 'no_ramp_match', `total=${(o.totalCents / 100).toFixed(2)}`].map(csv).join(','));

  let writes = 0, pdfsWritten = 0, attachFails = 0;
  for (const m of match.confident) {
    const rec = store.get(m.order.orderId)!;
    const entity = m.txn.entity;
    if (rec.parsedTotalCents !== m.txn.amountCents) { aside.push([m.order.orderId, 'no_reconcile', `inv=${rec.parsedTotalCents} txn=${m.txn.amountCents}`].map(csv).join(',')); continue; }
    // Re-consult the gate: the pool filter only proved SOME write was allowed, not which.
    const gate = decideWrites(m.txn);
    if (gate.blockedReason !== null) { aside.push([m.order.orderId, gate.blockedReason, `txn=${m.txn.id}`].map(csv).join(',')); continue; }
    const built = buildSplit(toParsed(rec, profile), m.txn.amountCents, glByEntity[entity]);
    if (!built) { aside.push([m.order.orderId, 'build_fail', ''].map(csv).join(',')); continue; }

    // Generate the itemized receipt PDF for this match (written to disk for review in every mode).
    const pdf = Buffer.from(await buildReceiptPdf(rec));
    const pdfPath = `${PDF_DIR}/${profile.key}-${m.order.orderId}.pdf`;
    writeFileSync(pdfPath, pdf); pdfsWritten++;

    const capped = args.live && args.cap > 0 && writes >= args.cap;
    const mode = args.live && !capped ? 'live' : 'dry_run';
    if (mode === 'live') {
      let wrote = false;
      if (gate.canSplit) {
        const res = await patchSplit(entity, m.txn.id, built.lines.map((l) => ({ amount: l.amount, memo: l.memo, accounting_field_selections: l.accounting_field_selections })), token[entity]);
        if (res.status < 200 || res.status >= 300) { aside.push([m.order.orderId, 'write_fail', `HTTP ${res.status}`].map(csv).join(',')); continue; }
        wrote = true;
        rollback.push({ entity, txn_id: m.txn.id, order_id: m.order.orderId, prior_line_items: m.txn.priorLineItems });
      } else {
        aside.push([m.order.orderId, 'split_skipped', 'already_enriched'].map(csv).join(','));
      }
      if (gate.canAttach) {
        if (!m.txn.userId) { aside.push([m.order.orderId, 'attach_fail', 'no user_id on txn'].map(csv).join(',')); attachFails++; }
        else {
          const att = await attachReceipt(entity, m.txn.id, pdf, `${profile.key}-${m.order.orderId}.pdf`, token[entity], m.txn.userId, receiptIdempotencyKey(profile.key, m.txn.id));
          if (att.status < 200 || att.status >= 300) { aside.push([m.order.orderId, 'attach_fail', `HTTP ${att.status}`].map(csv).join(',')); attachFails++; }
          else wrote = true;
        }
      } else {
        aside.push([m.order.orderId, 'attach_skipped', 'receipt_exists'].map(csv).join(','));
      }
      if (wrote) writes++;
    }
    for (const l of built.lines) {
      preview.push([m.order.orderId, entity, m.txn.id, m.txn.date, (m.txn.amountCents / 100).toFixed(2), l.desc, (l.amount / 100).toFixed(2), l.glName, l.confidence, l.coded, pdfPath, mode].map(csv).join(','));
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
  console.log(`\n${profile.label} MODE: ${args.live ? `LIVE (cap ${args.cap || '∞'}, ${writes} written, ${attachFails} attach-fail)` : 'DRY-RUN (no writes; PDFs generated for review)'}`);
  console.log(`eligible orders ${cachedOrders.length} | confident ${match.confident.length} | ambiguous ${match.ambiguous.length} | unmatched ${match.unmatched.length} | PDFs ${pdfsWritten}`);
  const byEntity = new Map<string, number>();
  for (const m of match.confident) byEntity.set(m.txn.entity, (byEntity.get(m.txn.entity) ?? 0) + 1);
  console.log(`confident by entity: ${[...byEntity.entries()].map(([e, n]) => `${e}=${n}`).join(' ') || '(none)'}`);
  console.log(`Wrote ${OUT}/preview_splits.csv (${preview.length - 1} lines), ${OUT}/set_aside.csv (${aside.length - 1})${rollback.length ? `, ${OUT}/rollback.json (+${rollback.length})` : ''}. PDFs in ${PDF_DIR}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
