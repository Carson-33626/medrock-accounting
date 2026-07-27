// Ramp-side worklist: cleared card txns for a target vendor that are NOT synced and have NO
// receipt — the set whose docs this pipeline fills. Includes userId for POST /receipts.
import { rampGet } from '../ramp-split-push/ramp-client';
import type { Entity, RampTxn } from '../ramp-split-push/types';

export type Vendor = 'toprx' | 'uline';

export interface RawWorkTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  memo: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string; user_id?: string } | null;
  line_items: unknown;
}
interface Page { data: RawWorkTxn[]; page?: { next?: string } }

const MERCHANT_RE: Record<Vendor, RegExp> = {
  toprx: /top\s*rx/i,
  uline: /uline/i,
};

export function isVendorMerchant(vendor: Vendor, name: string | null): boolean {
  return MERCHANT_RE[vendor].test(name ?? '');
}

export function isWorklisted(t: RawWorkTxn): boolean {
  return (
    t.state === 'CLEARED' &&
    t.sync_status === 'NOT_SYNC_READY' &&
    (t.receipts ?? []).length === 0
  );
}

export async function fetchWorklist(vendor: Vendor, entity: Entity, token: string, pages = 100): Promise<RampTxn[]> {
  const out: RampTxn[] = [];
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && url !== null; i++) {
    const res: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    if (res.status !== 200) throw new Error(`Ramp ${entity} worklist page ${i} HTTP ${res.status}`);
    const rows: RawWorkTxn[] = res.body.data ?? [];
    for (const t of rows) {
      if (!isVendorMerchant(vendor, t.merchant_name) || !isWorklisted(t)) continue;
      const h = t.card_holder;
      out.push({
        id: t.id,
        entity,
        amountCents: Math.round(t.amount * 100),
        date: (t.user_transaction_time ?? '').slice(0, 10),
        cardId: null,
        cardHolder: h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() || null : null,
        userId: h?.user_id ?? null,
        memo: t.memo,
        merchantName: t.merchant_name,
        orderNo: null,
        priorLineItems: t.line_items,
      });
    }
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}
