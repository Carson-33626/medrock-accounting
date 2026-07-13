// READ-ONLY. Correct OCR probe: GET /receipts/{id}?include_ocr_data=true (the documented param).
// Measure how many Amazon receipts return populated ocr.line_items, split by file type, and dump one.
// Run: cd web && npx tsx scripts/amazon-enrich/_probe-ocr2.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPES = 'transactions:read receipts:read accounting:read';
const PAGES = 8;
const MAX = 60;

interface RawTxn { id: string; amount: number; merchant_name: string | null; receipts?: string[] }
interface Page { data: RawTxn[]; page?: { next?: string } }
interface OcrLine { item_name?: string; item_quantity?: number; item_unit_price?: number; item_total_price?: number }
interface Ocr { currency_code?: string; line_items?: OcrLine[]; taxes?: { tax_amount?: number; tax_name?: string }[] }
interface Rcpt { receipt_url?: string; ocr?: Ocr | null }

function extOf(url: string): string {
  const e = url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase() ?? 'none';
  return e === 'jpg' || e === 'jpeg' || e === 'png' ? 'image' : e;
}

async function main(): Promise<void> {
  let dumped = 0;
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPES);
    const rids: { rid: string; amt: number }[] = [];
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < PAGES && url && rids.length < MAX; i++) {
      const { body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      for (const t of body.data ?? []) if (/amazon/i.test(t.merchant_name ?? '') && t.receipts?.[0]) rids.push({ rid: t.receipts[0], amt: t.amount });
      url = body.page?.next ?? null;
    }
    const tally: Record<string, { total: number; ocr: number; items: number; reconciled: number }> = {
      pdf: { total: 0, ocr: 0, items: 0, reconciled: 0 }, image: { total: 0, ocr: 0, items: 0, reconciled: 0 }, none: { total: 0, ocr: 0, items: 0, reconciled: 0 },
    };
    for (const { rid, amt } of rids.slice(0, MAX)) {
      const { body } = await rampGet<Rcpt>(entity, `/receipts/${rid}?include_ocr_data=true`, token);
      const ext = extOf(body.receipt_url ?? '');
      const b = tally[ext] ?? tally.none;
      b.total++;
      const items = body.ocr?.line_items ?? [];
      if (body.ocr) b.ocr++;
      if (items.length) b.items++;
      // reconcile: Σ item_total_price + Σ taxes ≈ txn amount
      if (items.length) {
        const sum = items.reduce((a, l) => a + (l.item_total_price ?? 0), 0) + (body.ocr?.taxes ?? []).reduce((a, t) => a + (t.tax_amount ?? 0), 0);
        if (Math.abs(sum - amt) < 0.02) b.reconciled++;
        if (dumped < 2) {
          dumped++;
          console.log(`\n>>> ${entity} ${ext} receipt ${rid} txn $${amt} | ocr sum $${sum.toFixed(2)} ${Math.abs(sum - amt) < 0.02 ? 'RECONCILES' : 'off'}`);
          console.log('   line_items:', JSON.stringify(items).slice(0, 700));
          console.log('   taxes:', JSON.stringify(body.ocr?.taxes));
        }
      }
    }
    console.log(`\n${entity}: scanned ${rids.slice(0, MAX).length}`);
    for (const [ext, b] of Object.entries(tally)) if (b.total) console.log(`   ${ext}: total ${b.total} | ocr-present ${b.ocr} | with-lineitems ${b.items} | reconciles ${b.reconciled}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
