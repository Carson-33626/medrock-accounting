// scripts/receipt-enrichment/engines/receipt-capture/_verify-uline.ts
//
// Live verify for the ULINE storageState session provider (task 7 pivot). REQUIRES a bootstrapped
// session at scripts/receipt-enrichment/cache/receipt-capture/.state/uline-FL.json (run uline-bootstrap.ts --entity=FL
// once, by hand, if missing). Run from web/:
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_verify-uline.ts
// Expected: account name printed, roster rows printed (invoice+order+date), a sample PDF saved,
// first bytes %PDF. Tries headless first; if ULINE rejects the headless reuse of a headed-created
// session (challenge/redirect), retries once headed.
import '../ramp-split-push/load-env';
import { withUlineContext } from './uline-session';
import { getUlineAccountName, scrapeUlineRoster, fetchUlineInvoicePdf } from './uline-cdp';
import { mkdirSync, writeFileSync } from 'fs';
import type { Page } from '@playwright/test';

const ENTITY = 'FL';

async function verify(page: Page): Promise<void> {
  const account = await getUlineAccountName(page);
  console.log(`account: ${account}`);

  const roster = await scrapeUlineRoster(page);
  console.log(`roster rows: ${roster.length}`);
  console.log(roster.slice(0, 5));

  if (roster.length > 0) {
    const pdf = await fetchUlineInvoicePdf(page, roster[0]);
    mkdirSync('scripts/receipt-enrichment/engines/receipt-capture/fixtures', { recursive: true });
    writeFileSync('scripts/receipt-enrichment/engines/receipt-capture/fixtures/uline-invoice-sample.pdf', pdf);
    console.log(`sample PDF: ${pdf.length} bytes -> fixtures/uline-invoice-sample.pdf`);
    console.log(`%PDF magic bytes: ${pdf.subarray(0, 4).toString('latin1') === '%PDF'}`);
  }
}

async function main(): Promise<void> {
  try {
    console.log('--- attempt 1: headless ---');
    await withUlineContext(ENTITY, verify, { headless: true });
    console.log('headless reuse OK');
  } catch (e) {
    console.log(`headless attempt failed: ${(e as Error).message}`);
    console.log('--- attempt 2: headed (retry) ---');
    await withUlineContext(ENTITY, verify, { headless: false });
    console.log('headed reuse OK (headless was rejected)');
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
