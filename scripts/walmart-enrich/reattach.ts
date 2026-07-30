// Re-attach receipts to txns that were already split by a prior live run but whose receipt upload failed
// (the 422 user_id/idempotency_key bug). Reads rollback.json for the (entity, txn_id, order_id) set,
// generates the itemized PDF from cache, and uploads. Attach-only: never re-touches the split.
//
// Safety, learned the hard way: this tool is what an operator reaches for AFTER a partial live run, so it
// is the most likely source of a duplicate receipt — and Ramp has no receipt-delete API. It therefore
// re-reads each transaction and refuses to attach when one is already present, rather than relying on the
// idempotency key alone. It shares run-cdp-split's key builder so the two runners still dedupe against
// each other; they diverged briefly on 2026-07-30 when run-cdp-split moved to txn-scoped keys.
//   npx tsx scripts/walmart-enrich/reattach.ts [--retailer walmart|sams] [--ramp-pages 60]
import './../ramp-split-push/load-env';
import { readFileSync, existsSync } from 'node:fs';
import { rampToken } from '../amazon-enrich/client';
import { rampGet } from '../ramp-split-push/ramp-client';
import { attachReceipt, receiptIdempotencyKey } from './ramp-receipts';
import { loadStore } from './extraction-store';
import { resolveProfile } from './retailer-profile';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

function arg(flag: string, def: string): string {
  const eq = process.argv.find((x) => x.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1) || def;
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

interface RollbackRow { entity?: Entity; txn_id: string; order_id: string }
interface TxnBody { state?: string | null; sync_status?: string | null; receipts?: string[] | null; card_holder?: { user_id?: string } | null }

async function main(): Promise<void> {
  const profile = resolveProfile(arg('--retailer', 'walmart'));
  const ROLLBACK = `${profile.outDir}/rollback.json`;
  if (!existsSync(ROLLBACK)) throw new Error(`No ${ROLLBACK} — nothing to re-attach.`);
  const rows = JSON.parse(readFileSync(ROLLBACK, 'utf8')) as RollbackRow[];
  const store = loadStore(profile.cacheFile);

  // One token per entity actually present in the rollback file. Rows written before 2026-07-30 predate
  // the entity field; those came from the FL-only runner, so FL is the correct fallback for them.
  const token: Partial<Record<Entity, string>> = {};
  const tokenFor = async (e: Entity): Promise<string> => {
    const cached = token[e];
    if (cached) return cached;
    const t = await rampToken(e, 'transactions:read receipts:read receipts:write');
    token[e] = t;
    return t;
  };

  let ok = 0, fail = 0, skip = 0;
  for (const row of rows) {
    const { txn_id, order_id } = row;
    const entity: Entity = row.entity ?? 'FL';
    if (!ALL_ENTITIES.includes(entity)) { console.log(`  ${txn_id}: unknown entity ${entity} — skip`); skip++; continue; }
    const rec = store.get(order_id);
    if (!rec) { console.log(`  ${order_id}: not in cache — skip`); skip++; continue; }

    const t = await tokenFor(entity);
    const fresh = await rampGet<TxnBody>(entity, `/transactions/${txn_id}`, t);
    if (fresh.status !== 200) { console.log(`  ${txn_id}: re-read HTTP ${fresh.status} — skip`); skip++; continue; }
    // Absent receipts array reads as "unknown", which blocks: a duplicate receipt cannot be undone.
    if (fresh.body.receipts == null || fresh.body.receipts.length > 0) {
      console.log(`  ${order_id} -> ${txn_id}: receipt already present (or unreadable) — skip`);
      skip++; continue;
    }
    const userId = fresh.body.card_holder?.user_id;
    if (!userId) { console.log(`  ${txn_id}: no user_id on txn — skip`); skip++; continue; }

    const { buildReceiptPdf } = await import('./receipt-pdf');
    const pdf = Buffer.from(await buildReceiptPdf(rec));
    const res = await attachReceipt(entity, txn_id, pdf, `${profile.key}-${order_id}.pdf`, t, userId, receiptIdempotencyKey(profile.key, txn_id));
    // DEVELOPER_7005 "Idempotency key already exists" = this runner already uploaded for this txn —
    // a success for our purposes, not a failure.
    const alreadyAttached = res.status === 400 && JSON.stringify(res.body).includes('DEVELOPER_7005');
    if ((res.status >= 200 && res.status < 300) || alreadyAttached) { ok++; console.log(`  [${entity}] ${order_id} -> ${txn_id}: ${alreadyAttached ? 'already attached' : `attached (${res.status})`}`); }
    else { fail++; console.log(`  [${entity}] ${order_id} -> ${txn_id}: FAIL ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`); }
  }
  console.log(`\nRE-ATTACH done: ${ok} attached | ${fail} failed | ${skip} skipped (of ${rows.length}).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
