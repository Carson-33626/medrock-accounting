// READ-ONLY. The Receipt schema HAS an `ocr` field ({currency_code, line_items[], taxes[]}) but it's
// omitted/null on many receipts. Scan a broad sample of Amazon receipts per entity and measure: how
// often is `ocr` populated with line_items? Split by receipt file type (pdf vs image) — because if
// OCR is populated for PNGs, it closes the image gap with no vision key. Dump one populated sample.
// Run: cd web && npx tsx scripts/amazon-enrich/_probe-ocr-scan.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPES = 'transactions:read receipts:read accounting:read';
const PAGES = 10;
const MAX_RECEIPTS = 80; // per entity, cap API calls

interface RawTxn { id: string; amount: number; merchant_name: string | null; receipts?: string[] }
interface Page { data: RawTxn[]; page?: { next?: string } }
interface OcrLine { item_name?: string; item_quantity?: number; item_unit_price?: number; item_total_price?: number }
interface Ocr { currency_code?: string; line_items?: OcrLine[]; taxes?: { tax_amount?: number }[] }
interface ReceiptResp { receipt_url?: string; ocr?: Ocr | null }

function extOf(url: string): string {
  const e = url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase() ?? 'none';
  return e === 'jpg' || e === 'jpeg' ? 'image' : e === 'png' ? 'image' : e;
}

async function main(): Promise<void> {
  let dumped = false;
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPES);
    const rids: string[] = [];
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < PAGES && url && rids.length < MAX_RECEIPTS; i++) {
      const { body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      for (const t of body.data ?? []) {
        if (/amazon/i.test(t.merchant_name ?? '') && t.receipts?.[0]) rids.push(t.receipts[0]);
      }
      url = body.page?.next ?? null;
    }
    const tally: Record<string, { total: number; ocr: number; ocrItems: number }> = {
      pdf: { total: 0, ocr: 0, ocrItems: 0 }, image: { total: 0, ocr: 0, ocrItems: 0 }, none: { total: 0, ocr: 0, ocrItems: 0 },
    };
    for (const rid of rids.slice(0, MAX_RECEIPTS)) {
      const { body } = await rampGet<ReceiptResp>(entity, `/receipts/${rid}`, token);
      const ext = extOf(body.receipt_url ?? '');
      const bucket = tally[ext] ?? tally.none;
      bucket.total++;
      const items = body.ocr?.line_items?.length ?? 0;
      if (body.ocr) bucket.ocr++;
      if (items > 0) bucket.ocrItems++;
      if (!dumped && items > 0) {
        dumped = true;
        console.log(`\n>>> SAMPLE POPULATED OCR (${entity} ${ext} receipt ${rid}):`);
        console.log(JSON.stringify(body.ocr, null, 1).slice(0, 1200));
      }
    }
    console.log(`\n${entity}: scanned ${rids.slice(0, MAX_RECEIPTS).length} Amazon receipts`);
    for (const [ext, b] of Object.entries(tally)) if (b.total) console.log(`   ${ext}: total ${b.total} | ocr-present ${b.ocr} | ocr-with-lineitems ${b.ocrItems}`);
  }
  if (!dumped) console.log('\n(no receipt in the sample had ocr.line_items populated)');
}
main().catch((e) => { console.error(e); process.exit(1); });
