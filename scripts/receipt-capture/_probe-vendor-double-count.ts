// Diagnostic: for one vendor, is the same spend recorded TWICE (Ramp card charge synced to QB as
// its own expense, AND a hand-keyed Bill), or correctly ONCE (Bill = expense, card charge applied
// as the BillPayment)? Decides whether receipt/split automation is safe for QB-billed vendors.
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-vendor-double-count.ts "DropperBottles"
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const NEEDLE = process.argv[2] ?? 'DropperBottles';
const SINCE = process.argv[3] ?? '2026-01-01';

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface QBRef { value: string; name?: string }
interface QBDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: QBRef;
  EntityRef?: QBRef;
  Balance?: number;
  PaymentType?: string;
  Line?: { LinkedTxn?: { TxnId?: string; TxnType?: string }[] }[];
}

async function main(): Promise<void> {
  console.log(`vendor "${NEEDLE}", on/after ${SINCE}\n`);

  // --- Ramp side: how many of this vendor's charges actually reach QB? ---
  const bySync = new Map<string, { n: number; total: number }>();
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 200 && url !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      for (const t of rows) {
        if (!(t.merchant_name ?? '').toLowerCase().includes(NEEDLE.toLowerCase())) continue;
        if ((t.user_transaction_time ?? '').slice(0, 10) < SINCE) continue;
        const k = `${t.state ?? '?'} / sync=${t.sync_status ?? 'null'}`;
        const a = bySync.get(k) ?? { n: 0, total: 0 };
        a.n++;
        a.total += Math.abs(t.amount);
        bySync.set(k, a);
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
  }
  console.log('=== RAMP txns by state / sync_status ===');
  for (const [k, v] of [...bySync.entries()].sort()) {
    console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(3)} txns  $${v.total.toFixed(2)}`);
  }
  console.log('  (SYNCED means Ramp pushed it into QB as its own document)');

  // --- QB side: Bills, their open balance, and whether payments are linked ---
  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    const bills = (await qbQueryAll<QBDoc>(loc, 'Bill', `WHERE TxnDate >= '${SINCE}'`))
      .filter((d) => (d.VendorRef?.name ?? '').toLowerCase().includes(NEEDLE.toLowerCase()));
    const purchases = (await qbQueryAll<QBDoc>(loc, 'Purchase', `WHERE TxnDate >= '${SINCE}'`))
      .filter((d) => (d.EntityRef?.name ?? d.VendorRef?.name ?? '').toLowerCase().includes(NEEDLE.toLowerCase()));
    const payments = (await qbQueryAll<QBDoc>(loc, 'BillPayment', `WHERE TxnDate >= '${SINCE}'`))
      .filter((d) => (d.VendorRef?.name ?? '').toLowerCase().includes(NEEDLE.toLowerCase()));

    if (bills.length === 0 && purchases.length === 0 && payments.length === 0) continue;
    console.log(`\n=== QUICKBOOKS ${entity} ===`);
    const openBills = bills.filter((b) => (b.Balance ?? 0) > 0.005);
    console.log(`  Bill         : ${bills.length} docs, $${bills.reduce((s, d) => s + (d.TotalAmt ?? 0), 0).toFixed(2)}`);
    console.log(`     of which still OPEN (Balance > 0): ${openBills.length}  $${openBills.reduce((s, d) => s + (d.Balance ?? 0), 0).toFixed(2)}`);
    console.log(`  BillPayment  : ${payments.length} docs, $${payments.reduce((s, d) => s + (d.TotalAmt ?? 0), 0).toFixed(2)}`);
    console.log(`  Purchase     : ${purchases.length} docs, $${purchases.reduce((s, d) => s + (d.TotalAmt ?? 0), 0).toFixed(2)}`);
    console.log(`     (a Purchase is a direct card/cash expense — a Ramp sync would land here)`);
  }

  console.log('\nREAD: Bills fully paid + BillPayments present => the card charge is applied to the Bill (correct, ONE expense).');
  console.log('      Bills open + Purchases mirroring the same amounts => the spend is recorded TWICE.');
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
