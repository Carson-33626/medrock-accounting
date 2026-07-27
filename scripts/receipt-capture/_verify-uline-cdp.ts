// scripts/receipt-capture/_verify-uline-cdp.ts
//
// Live verify for the ULINE CDP adapter (task 7). REQUIRES Carson's Chrome running with
// --remote-debugging-port=9222 and signed into uline.com. Run from web/:
//   npx tsx scripts/receipt-capture/_verify-uline-cdp.ts
// Expected: roster rows printed (invoice+order+date), a sample PDF saved, first bytes %PDF.
import '../ramp-split-push/load-env';
import { withUlinePage, scrapeUlineRoster, fetchUlineInvoicePdf } from './uline-cdp';
import { mkdirSync, writeFileSync } from 'fs';

async function main(): Promise<void> {
  await withUlinePage(async (page) => {
    const roster = await scrapeUlineRoster(page);
    console.log(`roster rows: ${roster.length}`);
    console.log(roster.slice(0, 5));
    if (roster.length > 0) {
      const pdf = await fetchUlineInvoicePdf(page, roster[0]);
      mkdirSync('scripts/receipt-capture/fixtures', { recursive: true });
      writeFileSync('scripts/receipt-capture/fixtures/uline-invoice-sample.pdf', pdf);
      console.log(`sample PDF: ${pdf.length} bytes -> fixtures/uline-invoice-sample.pdf`);
    }
  });
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
