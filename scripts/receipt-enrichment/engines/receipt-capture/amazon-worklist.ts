// Ramp-side worklist for the Amazon stream reversal: ALL cleared, never-synced Amazon-family
// txns — with or without receipts (no-receipt rows feed the C4 gap list, they are not excluded).
// Different eligibility from worklist.ts (which requires missing-receipt), so it lives apart.
import { rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';
import { isEnrichedLines } from '../amazon-enrich/client';

export interface RawAmazonTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  memo: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string; user_id?: string } | null;
  line_items: { memo?: string | null }[] | null;
}
interface Page { data: RawAmazonTxn[]; page?: { next?: string } }

export interface AmazonWorkTxn {
  id: string;
  entity: Entity;
  amountCents: number;
  date: string;
  cardHolder: string | null;
  userId: string | null;
  memo: string | null;
  merchantName: string | null;
  merchantDescriptor: string | null;
  receiptIds: string[];
  lineMemos: string[]; // non-empty line-item memos — an order-id source for C3
  enriched: boolean; // multi-line split OR single line carrying a product memo
  priorLineItems: unknown; // raw snapshot for the audit trail (re-reversible un-split)
}

// Amazon RETAIL family only: the QBO Amazon-direct connection itemizes amazon.com orders.
// AWS bills separately and never appears in that queue — keep it out of the reversal.
export function isAmazonFamily(name: string | null): boolean {
  const n = name ?? '';
  if (/web\s*services|\baws\b/i.test(n)) return false;
  return /amazon|amzn/i.test(n);
}

// Eligibility: cleared + never pushed to QBO. SYNCED/SYNC_READY are untouchable by design.
export function isAmazonWorklisted(t: RawAmazonTxn): boolean {
  return t.state === 'CLEARED' && t.sync_status === 'NOT_SYNC_READY';
}

export async function fetchAmazonWorklist(entity: Entity, token: string, pages = 100): Promise<AmazonWorkTxn[]> {
  const out: AmazonWorkTxn[] = [];
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && url !== null; i++) {
    // Ramp intermittently 404s mid-pagination ("access token not found") — retry with backoff.
    let res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    for (let attempt = 0; res.status !== 200 && attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      res = await rampGet<Page>(entity, url, token);
    }
    if (res.status !== 200) throw new Error(`Ramp ${entity} amazon worklist page ${i} HTTP ${res.status}`);
    const rows: RawAmazonTxn[] = res.body.data ?? [];
    for (const t of rows) {
      if (!isAmazonFamily(t.merchant_name) || !isAmazonWorklisted(t)) continue;
      const lines = t.line_items ?? [];
      const h = t.card_holder;
      out.push({
        id: t.id,
        entity,
        amountCents: Math.round(t.amount * 100),
        date: (t.user_transaction_time ?? '').slice(0, 10),
        cardHolder: h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() || null : null,
        userId: h?.user_id ?? null,
        memo: t.memo,
        merchantName: t.merchant_name,
        merchantDescriptor: t.merchant_descriptor,
        receiptIds: t.receipts ?? [],
        lineMemos: lines.map((l) => (l.memo ?? '').trim()).filter((m) => m.length > 0),
        enriched: isEnrichedLines(lines),
        priorLineItems: t.line_items,
      });
    }
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}
