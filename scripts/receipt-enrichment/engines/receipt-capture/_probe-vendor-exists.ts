// Diagnostic: does a vendor exist ANYWHERE (Ramp merchants all-time, QB vendor master, QB docs)?
// Answers "is X a target" for a name that does not show up in the receiptless scan. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-vendor-exists.ts Fagron
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../../../src/lib/quickbooks-multi';

const NEEDLE = (process.argv[2] ?? 'Fagron').toLowerCase();

interface RawTxn {
  id: string;
  amount: number;
  merchant_name: string | null;
  user_transaction_time: string | null;
  sync_status: string | null;
  receipts: string[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface QBVendor { Id: string; DisplayName?: string; Active?: boolean }
interface QBRef { value: string; name?: string }
interface QBDoc { Id: string; TxnDate?: string; TotalAmt?: number; VendorRef?: QBRef; EntityRef?: QBRef }

async function main(): Promise<void> {
  console.log(`searching for "${NEEDLE}" (all time)\n`);

  console.log('=== RAMP merchants (every txn the API returns, no date filter) ===');
  let rampHits = 0;
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 200 && url !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      for (const t of rows) {
        if (!(t.merchant_name ?? '').toLowerCase().includes(NEEDLE)) continue;
        rampHits++;
        console.log(`  ${entity} ${(t.user_transaction_time ?? '').slice(0, 10)} $${Math.abs(t.amount).toFixed(2).padStart(9)} receipts=${(t.receipts ?? []).length} sync=${t.sync_status} "${t.merchant_name}"`);
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
  }
  if (rampHits === 0) console.log('  none');

  console.log('\n=== QB VENDOR MASTER (name match) ===');
  let vendHits = 0;
  const vendorIds = new Map<string, string>();
  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    const vendors = await qbQueryAll<QBVendor>(loc, 'Vendor', '');
    for (const v of vendors) {
      if (!(v.DisplayName ?? '').toLowerCase().includes(NEEDLE)) continue;
      vendHits++;
      vendorIds.set(`${entity}|${v.Id}`, v.DisplayName ?? '');
      console.log(`  ${entity}  id=${v.Id}  active=${v.Active ?? '?'}  "${v.DisplayName}"`);
    }
  }
  if (vendHits === 0) console.log('  none');

  console.log('\n=== QB DOCS since 2024-01-01 ===');
  let docHits = 0;
  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    for (const kind of ['Bill', 'Purchase']) {
      const docs = await qbQueryAll<QBDoc>(loc, kind, `WHERE TxnDate >= '2024-01-01'`);
      const hits = docs.filter((d) => ((d.VendorRef?.name ?? d.EntityRef?.name ?? '').toLowerCase().includes(NEEDLE)));
      for (const d of hits) {
        docHits++;
        console.log(`  ${entity} ${kind.padEnd(8)} ${d.TxnDate} $${(d.TotalAmt ?? 0).toFixed(2).padStart(10)}`);
      }
    }
  }
  if (docHits === 0) console.log('  none');

  console.log(`\nSUMMARY: ramp=${rampHits} txns | qb vendor records=${vendHits} | qb docs=${docHits}`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
