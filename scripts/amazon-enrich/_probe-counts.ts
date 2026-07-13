// READ-ONLY. Real coverage counts: across ALL recent pages per entity, how many Amazon txns are
// (a) not-yet-enriched (<=1 line_item), (b) have a receipt, (c) sync state. Plus: sample a receipt
// file's content-type (PDF vs image) and test whether an `ocr` expand exists.
// Run: cd web && npx tsx scripts/amazon-enrich/_probe-counts.ts
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPES = 'transactions:read receipts:read accounting:read';
const PAGES = 15;

interface RawTxn {
  id: string;
  amount: number;
  merchant_name: string | null;
  sync_status?: string;
  line_items?: unknown[];
  receipts?: string[];
  user_transaction_time?: string;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    let token: string;
    try { token = await rampToken(entity, SCOPES); } catch (e) {
      console.log(`${entity}: token FAILED ${(e as Error).message}`); continue;
    }
    const amazon: RawTxn[] = [];
    let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    let oldest = '';
    for (let i = 0; i < PAGES && url; i++) {
      const { status, body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (status !== 200) break;
      const rows = body.data ?? [];
      if (rows.length === 0) break;
      oldest = rows[rows.length - 1].user_transaction_time?.slice(0, 10) ?? oldest;
      for (const t of rows) if (/amazon/i.test(t.merchant_name ?? '')) amazon.push(t);
      url = body.page?.next ?? null;
    }
    const notSplit = amazon.filter((t) => (t.line_items?.length ?? 0) <= 1);
    const withReceipt = amazon.filter((t) => (t.receipts?.length ?? 0) > 0);
    const eligible = notSplit.filter((t) => (t.receipts?.length ?? 0) > 0);
    const notSynced = amazon.filter((t) => t.sync_status === 'NOT_SYNC_READY');
    console.log(
      `${entity}: ${amazon.length} Amazon (back to ${oldest}) | not-split ${notSplit.length} | ` +
      `w/receipt ${withReceipt.length} | ELIGIBLE(not-split+receipt) ${eligible.length} | not-synced ${notSynced.length}`,
    );

    // sample a receipt url extension (PDF vs image) + does ?expand=ocr yield anything? (Ramp API only)
    const s = eligible[0];
    const rid = s?.receipts?.[0];
    if (rid) {
      const r = await rampGet<{ receipt_url?: string; ocr?: unknown }>(entity, `/receipts/${rid}`, token);
      const rurl = r.body.receipt_url ?? '';
      const ext = (rurl.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? 'none').toLowerCase();
      const rx = await rampGet<{ ocr?: unknown }>(entity, `/receipts/${rid}?expand=ocr`, token);
      console.log(`   sample receipt url ext=${ext} | ocr(plain)=${r.body.ocr !== undefined} | ocr(expand)=${rx.body.ocr !== undefined}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
