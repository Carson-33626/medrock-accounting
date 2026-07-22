// Download the Amazon Business "Transactions" report (actual batched card charges + the order numbers
// each reconciles to) for a location, via the one signed-in login's account switcher. Saves raw CSV;
// this is the charge-level source that pairs 1:1 with Ramp txns (the Items report is order-level).
//   npx tsx scripts/amazon-csv-enrich/run-extract-txns.ts --account FL|TN|TX [--span PAST_12_MONTHS] [--no-switch]
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { withAmazonPage } from './amazon-cdp';
import { downloadItemsReportCsv } from './report-download';
import type { DateSpan } from './report-download';
import { switchToBusiness, BUSINESS_BY_ACCOUNT } from './account-switcher';

function arg(flag: string, def: string): string { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const has = (flag: string): boolean => process.argv.includes(flag);

async function main(): Promise<void> {
  const account = arg('--account', '');
  if (!account) throw new Error('Pass --account FL|TN|TX');
  const span = arg('--span', 'PAST_12_MONTHS') as DateSpan;
  const targetBusiness = arg('--business', '') || BUSINESS_BY_ACCOUNT[account] || '';
  const OUT = `scripts/amazon-csv-enrich/out/${account}`;
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const csv = await withAmazonPage(async (page) => {
    if (targetBusiness && !has('--no-switch')) { console.log(`[${account}] switching to "${targetBusiness}"...`); await switchToBusiness(page, targetBusiness); }
    console.log(`[${account}] downloading transactions report (${span})...`);
    return downloadItemsReportCsv(page, span, { reportType: 'transactions_report' });
  });

  const path = `${OUT}/transactions.csv`;
  writeFileSync(path, csv);
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  console.log(`[${account}] wrote ${path} — ${lines.length} lines (incl header)`);
  console.log(`\n=== HEADER ===\n${lines[0] ?? '(empty)'}`);
  console.log(`\n=== FIRST 3 DATA ROWS ===`);
  for (const l of lines.slice(1, 4)) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
