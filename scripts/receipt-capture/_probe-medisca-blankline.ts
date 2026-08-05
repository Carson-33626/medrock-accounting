// Probe: TN draft 04233232 has three $60 lines — two gloves (S, M) and one with an EMPTY memo that
// blocks the whole draft. Read the attached invoice and find out what the third line actually is.
//   npx tsx scripts/receipt-capture/_probe-medisca-blankline.ts
import '../ramp-split-push/load-env';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';

const DRAFT_ID = '79112039-3243-48e2-9d69-ff6e7a373dd8';

interface DraftLine { amount?: { amount?: number }; memo?: string | null }
interface DraftDetail {
  invoice_number?: string | null;
  memo?: string | null;
  line_items?: DraftLine[];
  invoice_urls?: string[];
}

async function main(): Promise<void> {
  const token = await rampToken('TN', 'bills:read accounting:read');
  const res = await rampGet<DraftDetail>('TN', `/bills/drafts/${DRAFT_ID}`, token);
  const d = res.body;
  console.log(`HTTP ${res.status} | invoice=${d.invoice_number} | memo=${JSON.stringify(d.memo)}`);
  for (const l of d.line_items ?? []) {
    console.log(`  $${((l.amount?.amount ?? 0) / 100).toFixed(2).padStart(9)}  ${JSON.stringify(l.memo)}`);
  }

  const urls = d.invoice_urls ?? [];
  console.log(`\ninvoice_urls: ${urls.length}`);
  for (const url of urls) {
    const r = await fetch(url);
    const buf = Buffer.from(await r.arrayBuffer());
    const magic = buf.subarray(0, 4).toString('latin1');
    console.log(`\n--- HTTP ${r.status}, ${buf.length} bytes, magic=${JSON.stringify(magic)} ---`);
    if (magic !== '%PDF') { console.log('(not a PDF)'); continue; }
    const parsed = await pdfParse(buf);
    console.log(parsed.text.slice(0, 5000));
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
