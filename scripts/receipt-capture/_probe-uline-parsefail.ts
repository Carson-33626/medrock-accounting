// Diagnostic: why do ~98 ULINE invoices fail parseUlineInvoice? Fetches ONE failing invoice's PDF
// and dumps its extracted text next to a known-good one. READ-ONLY (no Ramp, no cache writes).
//   npx tsx scripts/receipt-capture/_probe-uline-parsefail.ts <failingInvoiceNumber>
import '../ramp-split-push/load-env';
import { withUlineContext } from './uline-session';
import { scrapeUlineRoster, fetchUlineInvoicePdf } from './uline-cdp';
import { parseUlineInvoice } from './uline-parser';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { Page } from '@playwright/test';

const TARGET = process.argv[2] ?? '201423174';
const GOOD_PDF = 'scripts/receipt-capture/out/pdf/uline-FL-201471906.pdf';

async function textOf(buf: Buffer): Promise<string> {
  const parsed: { text: string } = await pdfParse(buf);
  return parsed.text;
}

function show(label: string, text: string): void {
  console.log(`\n======== ${label} (${text.length} chars) ========`);
  console.log(text.slice(0, 1800));
  console.log(`======== end ${label} ========`);
}

async function probe(page: Page): Promise<void> {
  const roster = await scrapeUlineRoster(page, { since: '2025-01-01' });
  const inv = roster.find((r) => r.invoiceNumber === TARGET);
  if (!inv) {
    console.log(`invoice ${TARGET} not found in roster of ${roster.length}`);
    return;
  }
  console.log(`found: inv=${inv.invoiceNumber} order=${inv.orderNumber} date=${inv.date}`);
  const pdf = await fetchUlineInvoicePdf(page, inv);
  console.log(`pdf bytes: ${pdf.length}  %PDF=${pdf.subarray(0, 4).toString('latin1') === '%PDF'}`);
  const failText = await textOf(pdf);
  show(`FAILING ${TARGET}`, failText);
  const res = parseUlineInvoice(failText);
  console.log(`parseUlineInvoice -> ${res === null ? 'null (FAIL)' : `ok, ${res.items.length} items`}`);
}

async function main(): Promise<void> {
  show('WORKING 201471906', await textOf(readFileSync(GOOD_PDF)));
  await withUlineContext('FL', probe, { headless: true });
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
