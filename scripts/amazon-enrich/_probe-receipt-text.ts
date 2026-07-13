// READ-ONLY. Among eligible Amazon txns: measure receipt file-type split (pdf/png/other) per
// entity, then download the first PDF receipt and dump its extracted text so we can rebuild the
// parser against the real layout. Run: cd web && npx tsx scripts/amazon-enrich/_probe-receipt-text.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const ENTITIES: Entity[] = ['FL', 'TN'];
const SCOPES = 'transactions:read receipts:read accounting:read';
const PAGES = 8;

interface RawTxn { id: string; amount: number; merchant_name: string | null; line_items?: unknown[]; receipts?: string[] }
interface Page { data: RawTxn[]; page?: { next?: string } }

async function fetchBytes(url: string): Promise<Buffer> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPES);
    const amazon: RawTxn[] = [];
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < PAGES && url; i++) {
      const { body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      const rows = body.data ?? [];
      if (!rows.length) break;
      for (const t of rows) if (/amazon/i.test(t.merchant_name ?? '')) amazon.push(t);
      url = body.page?.next ?? null;
    }
    const eligible = amazon.filter((t) => (t.line_items?.length ?? 0) <= 1 && (t.receipts?.length ?? 0) > 0);
    // classify ext by fetching receipt metadata
    const ext: Record<string, number> = {};
    let firstPdf: { txn: RawTxn; rurl: string } | null = null;
    for (const t of eligible.slice(0, 60)) {
      const rid = t.receipts![0];
      const { body } = await rampGet<{ receipt_url?: string }>(entity, `/receipts/${rid}`, token);
      const rurl = body.receipt_url ?? '';
      const e = (rurl.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? 'none').toLowerCase();
      ext[e] = (ext[e] ?? 0) + 1;
      if (e === 'pdf' && !firstPdf) firstPdf = { txn: t, rurl };
    }
    console.log(`\n=== ${entity}: ${eligible.length} eligible (sampled ${Math.min(60, eligible.length)} for ext) ===`);
    console.log('   ext split:', JSON.stringify(ext));
    if (firstPdf) {
      const bytes = await fetchBytes(firstPdf.rurl);
      const parsed = await pdfParse(bytes);
      console.log(`   --- SAMPLE PDF (txn ${firstPdf.txn.id}, amount $${firstPdf.txn.amount}) TEXT ---`);
      console.log(parsed.text.split('\n').map((l: string) => '   | ' + l).join('\n'));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
