// Re-attach receipts to txns that were already split by a prior live run but whose receipt upload failed
// (the 422 user_id/idempotency_key bug). Reads rollback.json for the (txn_id, order_id) set, looks up
// each txn's card_holder.user_id, generates the itemized PDF from cache, and uploads with a stable
// idempotency_key (so an already-attached receipt dedupes rather than duplicating). Attach-only: never
// re-touches the split.
//   npx tsx scripts/walmart-enrich/reattach.ts
import './../ramp-split-push/load-env';
import { readFileSync, existsSync } from 'node:fs';
import { rampToken } from '../amazon-enrich/client';
import { getRampTransactions } from '../ramp-split-push/ramp-client';
import { attachReceipt } from './ramp-receipts';
import { loadStore } from './extraction-store';
import type { Entity } from '../ramp-split-push/types';

const ENTITY: Entity = 'FL';
const CACHE = 'scripts/walmart-enrich/out/extraction-cache.json';
const ROLLBACK = 'scripts/walmart-enrich/out/rollback.json';

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  if (!existsSync(ROLLBACK)) throw new Error(`No ${ROLLBACK} — nothing to re-attach.`);
  const rows = JSON.parse(readFileSync(ROLLBACK, 'utf8')) as { txn_id: string; order_id: string }[];
  const rampPages = Number(arg('--ramp-pages', '60')) || 60;
  const store = loadStore(CACHE);
  const token = await rampToken(ENTITY, 'transactions:read transactions:write receipts:write accounting:read');

  // Map txn_id -> user_id (receipt upload needs the card holder's user id).
  const txns = await getRampTransactions(ENTITY, token, rampPages);
  const userById = new Map(txns.map((t) => [t.id, t.userId]));

  let ok = 0, fail = 0, skip = 0;
  for (const { txn_id, order_id } of rows) {
    const rec = store.get(order_id);
    const userId = userById.get(txn_id);
    if (!rec) { console.log(`  ${order_id}: not in cache — skip`); skip++; continue; }
    if (!userId) { console.log(`  ${txn_id}: no user_id (txn not in fetched window) — skip`); skip++; continue; }
    const { buildReceiptPdf } = await import('./receipt-pdf');
    const pdf = Buffer.from(await buildReceiptPdf(rec));
    const res = await attachReceipt(ENTITY, txn_id, pdf, `walmart-${order_id}.pdf`, token, userId, `walmart-receipt-${order_id}`);
    // DEVELOPER_7005 "Idempotency key already exists" = the receipt was already uploaded (this key is
    // stable per order) — that's a success for our purposes, not a failure.
    const alreadyAttached = res.status === 400 && JSON.stringify(res.body).includes('DEVELOPER_7005');
    if ((res.status >= 200 && res.status < 300) || alreadyAttached) { ok++; console.log(`  ${order_id} -> ${txn_id}: ${alreadyAttached ? 'already attached' : `attached (${res.status})`}`); }
    else { fail++; console.log(`  ${order_id} -> ${txn_id}: FAIL ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`); }
  }
  console.log(`\nRE-ATTACH done: ${ok} attached | ${fail} failed | ${skip} skipped (of ${rows.length}).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
