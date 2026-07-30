// Read-only: for a given txn id, print every attached receipt with its created_at and uploader. Receipt
// timestamps are the only way to tell "this run double-attached" (gate failure) from "the duplicate was
// already there" (pre-existing damage) — Ramp has no receipt-delete API, so the distinction decides
// whether a fix is needed or just a cleanup.
//   npx tsx scripts/walmart-enrich/_probe-receipt-times.ts FL <txnId> [<txnId> ...]
import './../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

interface Txn { id: string; amount: number; merchant_name?: string; receipts?: string[] }
interface Receipt { id: string; created_at?: string; receipt_date?: string; user_id?: string; transaction_id?: string }

async function main(): Promise<void> {
  const entity = process.argv[2] as Entity;
  const txnIds = process.argv.slice(3);
  const token = await rampToken(entity, 'transactions:read receipts:read accounting:read');
  for (const id of txnIds) {
    const { body: t } = await rampGet<Txn>(entity, `/transactions/${id}`, token);
    console.log(`\n${entity} ${id}  $${t.amount}  ${t.merchant_name ?? ''}  receipts=${t.receipts?.length ?? 0}`);
    for (const rid of t.receipts ?? []) {
      const { body: r } = await rampGet<Receipt>(entity, `/receipts/${rid}`, token);
      console.log(`   ${rid}  created_at=${r.created_at ?? '?'}  receipt_date=${r.receipt_date ?? '?'}  user=${r.user_id ?? '?'}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
