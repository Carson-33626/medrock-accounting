// READ-ONLY: find a $20.99 Amazon txn on/near 2026-03-26 across all Ramp entities.
import '../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

interface Raw {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  memo: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  line_items: { memo?: string | null }[] | null;
  sk_category_name?: string | null;
}
interface Page { data: Raw[]; page?: { next?: string } }

async function main(): Promise<void> {
  for (const entity of ['FL', 'TN', 'TX'] as Entity[]) {
    const token = await rampToken(entity, 'transactions:read');
    // window the pull around March 2026 via from/to params
    let url: string | null = '/transactions?page_size=100&from_date=2026-03-20T00:00:00Z&to_date=2026-04-02T00:00:00Z';
    for (let i = 0; i < 20 && url !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
      if (res.status !== 200) { console.error(`${entity} HTTP ${res.status}`); break; }
      for (const t of res.body.data ?? []) {
        const cents = Math.round(t.amount * 100);
        if (Math.abs(Math.abs(cents) - 2099) > 0) continue;
        const h = t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : '?';
        console.log(`\n${entity} | ${t.user_transaction_time} | ${t.merchant_name} (${t.merchant_descriptor ?? ''})`);
        console.log(`  id=${t.id}`);
        console.log(`  $${t.amount} | state=${t.state} | sync=${t.sync_status} | holder=${h}`);
        console.log(`  category=${t.sk_category_name ?? ''} | receipts=${(t.receipts ?? []).length} | memo=${t.memo ?? '(none)'}`);
        const lines = t.line_items ?? [];
        for (const l of lines) if ((l.memo ?? '').trim()) console.log(`  line: ${l.memo}`);
      }
      url = res.body.page?.next ?? null;
    }
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
