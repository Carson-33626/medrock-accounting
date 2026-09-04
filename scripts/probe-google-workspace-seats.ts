// READ-ONLY probe: pull the full Ramp + QBO detail behind the Google Workspace charges, including
// any OCR'd receipt line items, to see whether the seat count is stated on the invoice rather than
// having to be derived from the dollar amounts.
// Run from web/:  npx tsx scripts/probe-google-workspace-seats.ts
import './lib/load-env';
import { rampToken, rampGet } from './lib/ramp';

import { ALL_ENTITIES } from './lib/entities';
import { qbQueryAll, getConnectedLocations } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface RampLineItem {
  amount?: { amount?: number; currency_code?: string } | number | null;
  memo?: string | null;
  sku?: string | null;
  quantity?: number | null;
  unit_price?: { amount?: number } | number | null;
  description?: string | null;
}
interface RawRampTxn {
  id: string;
  amount: number;
  user_transaction_time: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  memo: string | null;
  state: string | null;
  receipts: string[] | null;
  line_items: RampLineItem[] | null;
}
interface RampPage {
  data: RawRampTxn[];
  page?: { next?: string };
}

interface QbLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
}
interface QbBill {
  Id?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  PrivateNote?: string;
  VendorRef?: { name?: string };
  Line?: QbLine[];
}

async function main(): Promise<void> {
  console.log('=== RAMP: Google Workspace / Google Cloud raw txn detail ===');
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true&from_date=2025-07-01T00:00:00Z';
    for (let i = 0; i < 400 && next !== null; i++) {
      const res: { status: number; body: RampPage } = await rampGet<RampPage>(entity, next, token);
      if (res.status !== 200) throw new Error(`Ramp ${entity} HTTP ${res.status}`);
      for (const t of res.body.data ?? []) {
        const name = `${t.merchant_name ?? ''} ${t.merchant_descriptor ?? ''}`;
        if (!/google/i.test(name)) continue;
        console.log(
          `\n  ${entity} ${(t.user_transaction_time ?? '').slice(0, 10)}  $${t.amount.toFixed(2)}  ${t.merchant_name}` +
            `  receipts=${(t.receipts ?? []).length}  id=${t.id}`,
        );
        if (t.memo) console.log(`     memo: ${t.memo.replace(/\s+/g, ' ').slice(0, 160)}`);
        const items = t.line_items ?? [];
        if (items.length > 0) {
          console.log(`     line_items (${items.length}):`);
          for (const li of items) console.log(`       ${JSON.stringify(li).slice(0, 300)}`);
        }
      }
      next = res.body.page?.next ?? null;
    }
  }

  console.log('\n\n=== QBO: Google Workspace bills, every line ===');
  const locations: Location[] = await getConnectedLocations();
  for (const location of locations) {
    const bills = await qbQueryAll<QbBill>(
      location,
      'Bill',
      "WHERE TxnDate >= '2025-07-01' ORDERBY TxnDate",
    );
    for (const b of bills) {
      if (!/google/i.test(b.VendorRef?.name ?? '')) continue;
      console.log(
        `\n  ${location}  ${b.TxnDate}  doc=${b.DocNumber ?? '-'}  total=$${(b.TotalAmt ?? 0).toFixed(2)}` +
          (b.PrivateNote ? `  note="${b.PrivateNote.replace(/\s+/g, ' ').slice(0, 80)}"` : ''),
      );
      for (const l of b.Line ?? []) {
        console.log(
          `      $${(l.Amount ?? 0).toFixed(2).padStart(9)}  ${(l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '').slice(0, 30).padEnd(32)}${(l.Description ?? '').replace(/\s+/g, ' ')}`,
        );
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
