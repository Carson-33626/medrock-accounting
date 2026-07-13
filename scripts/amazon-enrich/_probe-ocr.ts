// READ-ONLY. Thoroughly probe whether Ramp exposes OCR line-items for receipts (to close the PNG
// gap without a vision key). Full JSON dump of a PNG + a PDF Amazon receipt, several expand params,
// and the transaction-detail endpoint (in case OCR/suggested line-items live there).
// Run: cd web && npx tsx scripts/amazon-enrich/_probe-ocr.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const SCOPES = 'transactions:read receipts:read accounting:read';

interface RawTxn { id: string; merchant_name: string | null; receipts?: string[]; line_items?: unknown[] }
interface Page { data: RawTxn[]; page?: { next?: string } }

async function findAmazonWithReceipt(entity: Entity, token: string, wantExt: 'pdf' | 'image'): Promise<{ txn: RawTxn; rid: string } | null> {
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let p = 0; p < 10 && url; p++) {
    const { body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    for (const t of body.data ?? []) {
      if (!/amazon/i.test(t.merchant_name ?? '')) continue;
      const rid = t.receipts?.[0];
      if (!rid) continue;
      const { body: r } = await rampGet<{ receipt_url?: string }>(entity, `/receipts/${rid}`, token);
      const ext = (r.receipt_url ?? '').split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase() ?? '';
      const isImg = ext === 'png' || ext === 'jpg' || ext === 'jpeg';
      if ((wantExt === 'pdf' && ext === 'pdf') || (wantExt === 'image' && isImg)) return { txn: t, rid };
    }
    url = body.page?.next ?? null;
  }
  return null;
}

async function dump(label: string, entity: Entity, token: string, path: string): Promise<void> {
  const { status, body } = await rampGet<Record<string, unknown>>(entity, path, token);
  console.log(`\n--- ${label}  [HTTP ${status}]  ${path}`);
  const keys = Object.keys(body ?? {}).sort();
  console.log('   keys:', keys.join(', '));
  // surface anything that smells like OCR / itemization
  for (const k of keys) {
    if (/ocr|item|line|extract|parsed|receipt|tax/i.test(k)) {
      console.log(`   >> ${k}:`, JSON.stringify(body[k]).slice(0, 600));
    }
  }
}

async function main(): Promise<void> {
  const entity: Entity = 'TN'; // TN has the most PDFs; also try image
  const token = await rampToken(entity, SCOPES);
  for (const want of ['pdf', 'image'] as const) {
    const found = await findAmazonWithReceipt(entity, token, want);
    if (!found) { console.log(`\n### ${entity} ${want}: none found`); continue; }
    console.log(`\n############ ${entity} ${want.toUpperCase()} — txn ${found.txn.id} receipt ${found.rid} ############`);
    await dump('receipt', entity, token, `/receipts/${found.rid}`);
    await dump('receipt ?expand=ocr', entity, token, `/receipts/${found.rid}?expand=ocr`);
    await dump('receipt ?expand=line_items', entity, token, `/receipts/${found.rid}?expand=line_items`);
    await dump('txn detail', entity, token, `/transactions/${found.txn.id}`);
    await dump('txn detail ?expand=line_items.ocr', entity, token, `/transactions/${found.txn.id}?expand=line_items`);
  }
  // also check FL image (FL has the most PNGs)
  const flToken = await rampToken('FL', SCOPES);
  const flImg = await findAmazonWithReceipt('FL', flToken, 'image');
  if (flImg) {
    console.log(`\n############ FL IMAGE — txn ${flImg.txn.id} receipt ${flImg.rid} ############`);
    await dump('FL receipt', 'FL', flToken, `/receipts/${flImg.rid}`);
    await dump('FL txn detail', 'FL', flToken, `/transactions/${flImg.txn.id}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
