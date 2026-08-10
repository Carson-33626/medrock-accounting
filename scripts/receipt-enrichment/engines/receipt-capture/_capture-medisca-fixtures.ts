// Capture real Medisca fixtures so the parser tests run against the vendor's actual output rather
// than against my assumptions about it. Read-only.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_capture-medisca-fixtures.ts
import '../ramp-split-push/load-env';
import { writeFileSync, mkdirSync } from 'node:fs';
import { MediscaSession } from './medisca-session';

const DIR = 'scripts/receipt-enrichment/engines/receipt-capture/fixtures';

async function main(): Promise<void> {
  mkdirSync(DIR, { recursive: true });

  const fl = await MediscaSession.login('FL');
  console.log(`FL logged in: customer=${fl.customerCode} company=${fl.company}`);

  // The full unpaid list — this is the one that returned 46 rows where the default returned 20.
  const unpaid = await fl.get('/dashboard/invoices/unpaid-invoices?limit=100&page=1');
  writeFileSync(`${DIR}/medisca-unpaid-list-FL.html`, unpaid.text);
  console.log(`unpaid list: HTTP ${unpaid.status}, ${unpaid.text.length} bytes`);

  // The default page too, so a test can prove the truncation trap is real.
  const dflt = await fl.get('/dashboard/invoices/unpaid-invoices');
  writeFileSync(`${DIR}/medisca-unpaid-list-FL-default.html`, dflt.text);
  console.log(`default list: HTTP ${dflt.status}, ${dflt.text.length} bytes`);

  // Two invoices with known shapes:
  //   04245590 — 3 glove lines PLUS a -$10 shipping credit (the negative-line case)
  //   04245588 — single Bimatoprost line (the simple case, and a ruled item)
  for (const inv of ['04245590', '04245588']) {
    const pdf = await fl.fetchPdf(inv);
    writeFileSync(`${DIR}/medisca-invoice-${inv}.pdf`, pdf);
    console.log(`invoice ${inv}: ${pdf.length} bytes`);
  }

  // Order detail pages — the real line-item source (SKU, name, qty, unit price, subtotal, lot).
  //   04557192 -> invoice 04245590, three glove lines
  //   04461596 -> invoice 04245588, one Bimatoprost line
  //   04518277 -> invoice 04245589, a large multi-line order ($15,833)
  for (const order of ['04557192', '04461596', '04518277']) {
    const res = await fl.get(`/dashboard/orders/${order}`);
    writeFileSync(`${DIR}/medisca-order-${order}.html`, res.text);
    console.log(`order ${order}: HTTP ${res.status}, ${res.text.length} bytes`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
