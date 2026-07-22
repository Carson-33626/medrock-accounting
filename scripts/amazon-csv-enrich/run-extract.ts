// EXTRACT (run once per Amazon Business login): CDP-attach the signed-in Chrome, download the Items
// order-history CSV, parse to per-charge groups, fetch each order's invoice PDF, and write through the
// per-login resumable cache. No Ramp calls, no writes outside the local cache + index CSV.
//   npx tsx scripts/amazon-csv-enrich/run-extract.ts --account <label> [--business "<name>"] [--no-switch] [--span PAST_12_MONTHS] [--limit N] [--skip-invoices]
// For FL/TN/TX labels the target business is auto-switched in the one signed-in session; override with
// --business "<customerName>", or --no-switch to export whatever business is currently active.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { withAmazonPage } from './amazon-cdp';
import { downloadItemsReportCsv } from './report-download';
import type { DateSpan } from './report-download';
import { parseAmazonCsv } from './csv-parser';
import { fetchInvoicePdf } from './invoice-fetch';
import { loadChargeStore } from './extraction-store';
import { switchToBusiness, BUSINESS_BY_ACCOUNT } from './account-switcher';

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (flag: string): boolean => process.argv.includes(flag);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const account = arg('--account', '');
  if (!account) throw new Error('Pass --account <label> (a name for this login, e.g. FL / TX / grp1).');
  const span = arg('--span', 'PAST_12_MONTHS') as DateSpan;
  const limit = Number(arg('--limit', '0')) || 0;
  const skipInvoices = has('--skip-invoices');
  const noSwitch = has('--no-switch');
  const targetBusiness = arg('--business', '') || BUSINESS_BY_ACCOUNT[account] || '';

  const OUT = `scripts/amazon-csv-enrich/out/${account}`;
  const PDF_DIR = `scripts/amazon-csv-enrich/.receipts_cache/${account}`;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
  const store = loadChargeStore(`${OUT}/charges.json`);
  const now = new Date().toISOString();

  const stats = await withAmazonPage(async (page) => {
    if (targetBusiness && !noSwitch) {
      console.log(`[${account}] switching active business to "${targetBusiness}"...`);
      await switchToBusiness(page, targetBusiness);
    }
    console.log(`[${account}] downloading items report (${span})...`);
    const csv = await downloadItemsReportCsv(page, span);
    const charges = parseAmazonCsv(csv);
    console.log(`[${account}] parsed ${charges.length} charges from CSV`);

    let fetched = 0, cached = 0, failed = 0;
    for (const charge of charges) {
      if (limit && fetched >= limit) break; // bound by actual invoice fetches, not charges scanned
      const existing = store.get(charge.paymentRef);
      let pdfPath: string | null = existing?.invoicePdfPath ?? null;
      if (!skipInvoices && !pdfPath) {
        try {
          const pdf = await fetchInvoicePdf(page, charge.primaryOrderId);
          pdfPath = `${PDF_DIR}/amazon-${charge.primaryOrderId}.pdf`;
          writeFileSync(pdfPath, pdf);
          fetched++;
        } catch (e) {
          console.error(`  invoice ${charge.primaryOrderId} failed: ${(e as Error).message}`);
          failed++;
        }
        await sleep(1500); // polite pacing, after success OR failure
      } else if (pdfPath) {
        cached++;
      }
      store.put({ charge, invoicePdfPath: pdfPath, fetchedAt: now });
    }
    return { charges: charges.length, fetched, cached, failed };
  });

  const idx = ['payment_ref,order_id,account_group,charge,pay_date,card_last4,items,items_total,reconciles,pdf'];
  for (const r of store.all()) {
    const c = r.charge;
    idx.push([c.paymentRef, c.primaryOrderId, JSON.stringify(c.accountGroup), (c.chargeCents / 100).toFixed(2),
      c.payDate, c.cardLast4 ?? '', String(c.items.length), (c.itemsTotalCents / 100).toFixed(2),
      String(c.itemsTotalCents === c.chargeCents), r.invoicePdfPath ? '1' : '0'].join(','));
  }
  writeFileSync(`${OUT}/extraction-index.csv`, idx.join('\n'));
  console.log(`\n[${account}] EXTRACT done: ${stats.charges} charges | +${stats.fetched} invoices | ${stats.cached} cached | ${stats.failed} invoice-fail. cache=${store.all().length}. wrote ${OUT}/extraction-index.csv`);
}
main().catch((e) => { console.error(e); process.exit(1); });
