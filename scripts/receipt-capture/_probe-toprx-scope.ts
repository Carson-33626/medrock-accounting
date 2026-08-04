// Our 21 attached TopRx receipts are all populated PDFs, so "TopRx only gives blank receipts" is
// not describing them. This sizes the rest of the picture: every TopRx card transaction, whether it
// has a receipt at all, and — for the ones that do — whether that receipt carries readable text.
//
// Three outcomes need telling apart, because they need different fixes:
//   NO-RECEIPT   nothing ever attached to that txn        -> a coverage gap, not a blank file
//   EMPTY-TEXT   a receipt exists with no extractable text -> a genuinely blank file
//   HAS-TEXT     a populated receipt                       -> reads fine
// RampTxn carries only receiptCount, not receipt ids, so the ids come from GET /receipts (whose
// objects carry transaction_id) joined back to the transactions. READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-toprx-scope.ts [FL|TN|TX]
import '../ramp-split-push/load-env';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { rampGet, rampToken, getRampTransactions } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

interface RampReceipt { id?: string; receipt_url?: string; transaction_id?: string; user_id?: string }
interface ReceiptPage { data?: RampReceipt[]; page?: { next?: string | null } }

const MERCHANT_RE = /top\s*rx/i;

async function receiptsByTxn(entity: Entity, token: string): Promise<Map<string, RampReceipt[]>> {
  const map = new Map<string, RampReceipt[]>();
  let url: string | null = '/receipts?page_size=100';
  for (let i = 0; i < 60 && url !== null; i++) {
    const res: { status: number; body: ReceiptPage } = await rampGet<ReceiptPage>(entity, url, token);
    if (res.status !== 200) break;
    const rows = res.body.data ?? [];
    for (const r of rows) {
      const t = r.transaction_id ?? '';
      if (t === '') continue;
      map.set(t, [...(map.get(t) ?? []), r]);
    }
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return map;
}

async function main(): Promise<void> {
  const only = process.argv[2] ?? '';
  const entities: Entity[] = only === '' ? [...ALL_ENTITIES] : [only as Entity];

  for (const entity of entities) {
    const token = await rampToken(entity, 'transactions:read receipts:read');
    const txns = await getRampTransactions(entity, token, 40);
    const toprx = txns.filter((t) => MERCHANT_RE.test(t.merchantName ?? ''));
    const byTxn = await receiptsByTxn(entity, token);

    let noReceipt = 0, hasText = 0, emptyText = 0, unreadable = 0;
    const emptySamples: string[] = [];
    for (const t of toprx) {
      const recs = byTxn.get(t.id) ?? [];
      if (recs.length === 0) { noReceipt++; continue; }
      const url = recs[0].receipt_url ?? '';
      if (url === '') { unreadable++; continue; }
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      try {
        const p = await pdfParse(buf);
        const chars = (p.text ?? '').replace(/\s+/g, ' ').trim().length;
        if (chars < 200) {
          emptyText++;
          // state/syncStatus decide what is still POSSIBLE on this txn: Ramp has no receipt DELETE
          // and no unlock, so the only options are "add a second receipt" (always allowed) and
          // "re-split" (PATCH /transactions — 403s once SYNCED). Print both rather than guessing.
          if (emptySamples.length < 8) {
            emptySamples.push(
              `${t.date} $${(Math.abs(t.amountCents) / 100).toFixed(2)} txn=${t.id} ` +
              `state=${t.state ?? '?'} sync=${t.syncStatus ?? '?'} receipts=${recs.length} chars=${chars}`,
            );
          }
        } else hasText++;
      } catch {
        // Not a PDF — most likely a photo someone uploaded. Perfectly readable to her, no text to
        // us, so it must not be counted as blank.
        unreadable++;
      }
    }
    console.log(
      `[${entity}] TopRx txns=${toprx.length} | no_receipt=${noReceipt} has_text=${hasText} ` +
      `EMPTY_TEXT=${emptyText} non_pdf_or_unreadable=${unreadable}`,
    );
    for (const s of emptySamples) console.log(`    empty: ${s}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
