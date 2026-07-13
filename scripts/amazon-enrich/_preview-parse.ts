// READ-ONLY parser validation: over eligible FL+TN Amazon txns, fetch PDF receipts, parse, and
// measure the cent-reconcile rate (Σ item + tax + ship == txn amount). Dumps mismatch/parse-fail
// samples so we can harden the parser before any write. Caches receipts to scratch.
// Run: cd web && npx tsx scripts/amazon-enrich/_preview-parse.ts
import '../ramp-split-push/load-env';
import { rampToken, getEligibleAmazonTxns, getReceiptUrl, receiptExt, downloadReceipt } from './client';
import { parseReceiptPdf } from './receipt-parser';
import type { Entity } from '../ramp-split-push/types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const CACHE = 'scripts/amazon-enrich/.receipts_cache';
const ENTITIES: Entity[] = ['FL', 'TN'];
const SCOPES = 'transactions:read receipts:read accounting:read';
const PAGES = 15;

async function cachedReceipt(entity: Entity, rid: string, token: string): Promise<{ ext: string; bytes: Buffer } | null> {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const meta = `${CACHE}/${rid}.meta`;
  let url: string | null = null;
  let ext = 'none';
  if (existsSync(meta)) { const [u, e] = readFileSync(meta, 'utf8').split('\n'); url = u; ext = e; }
  else {
    url = await getReceiptUrl(entity, rid, token);
    if (!url) return null;
    ext = receiptExt(url);
    writeFileSync(meta, `${url}\n${ext}`);
  }
  if (ext !== 'pdf') return { ext, bytes: Buffer.alloc(0) };
  const file = `${CACHE}/${rid}.pdf`;
  if (existsSync(file)) return { ext, bytes: readFileSync(file) };
  const bytes = await downloadReceipt(url);
  writeFileSync(file, bytes);
  return { ext, bytes };
}

async function main(): Promise<void> {
  const tally: Record<string, number> = { reconciled: 0, mismatch: 0, parse_fail: 0, image: 0, dl_fail: 0 };
  const mismatches: string[] = [];
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, SCOPES);
    const txns = await getEligibleAmazonTxns(entity, token, PAGES);
    for (const t of txns) {
      if (!t.receiptId) continue;
      let rec: { ext: string; bytes: Buffer } | null = null;
      try { rec = await cachedReceipt(entity, t.receiptId, token); } catch { tally.dl_fail++; continue; }
      if (!rec) { tally.dl_fail++; continue; }
      if (rec.ext !== 'pdf') { tally.image++; continue; }
      let p;
      try { p = await parseReceiptPdf(rec.bytes); } catch { tally.parse_fail++; continue; }
      if (!p.layout || p.items.length === 0) { tally.parse_fail++; continue; }
      if (p.parsedTotalCents === t.amountCents) tally.reconciled++;
      else {
        tally.mismatch++;
        if (mismatches.length < 12) mismatches.push(
          `${entity} ${t.id.slice(0, 8)} amt=$${(t.amountCents / 100).toFixed(2)} parsed=$${(p.parsedTotalCents / 100).toFixed(2)} ` +
          `layout=${p.layout} items=${p.items.length} tax=${p.taxCents} ship=${p.shippingCents}`);
      }
    }
    console.log(`${entity} done.`);
  }
  console.log('\n=== PARSE/RECONCILE TALLY (PDF only) ===');
  console.log(tally);
  const pdfSeen = tally.reconciled + tally.mismatch + tally.parse_fail;
  console.log(`PDF reconcile rate: ${pdfSeen ? ((tally.reconciled / pdfSeen) * 100).toFixed(1) : 0}% of ${pdfSeen} PDFs`);
  console.log('\n=== MISMATCH SAMPLES ===');
  console.log(mismatches.join('\n') || '(none)');
}
main().catch((e) => { console.error(e); process.exit(1); });
