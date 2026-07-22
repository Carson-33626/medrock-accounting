// Fetch un-enriched, not-yet-synced Amazon Ramp transactions (the SPLIT match pool) with card last-4.
// Mirrors amazon-enrich getEligibleAmazonTxns but WITHOUT the has-receipt requirement (this tool ATTACHES
// the receipt) and WITH card_last_four for the inverted match. Re-exports the shared write primitives.
import { rampGet } from '../ramp-split-push/ramp-client';
import type { Entity, RampTxn } from '../ramp-split-push/types';

interface RawLine { memo?: string | null }
interface RawTxn {
  id: string;
  amount: number;
  user_transaction_time?: string;
  merchant_name: string | null;
  sync_status?: string;
  card_id?: string | null;
  card_last_four?: string | null; // confirm via _probe-txn-shape.ts
  card_holder?: { first_name?: string; last_name?: string; user_id?: string } | null;
  line_items?: RawLine[];
}
interface Page { data: RawTxn[]; page?: { next?: string } }

function isAmazon(name: string | null): boolean { return /amazon/i.test(name ?? ''); }

export function isTxnEnriched(priorLineItems: unknown): boolean {
  if (!Array.isArray(priorLineItems)) return false;
  const lines = priorLineItems as unknown[];
  if (lines.length > 1) return true;
  return lines.some((l) => {
    if (typeof l !== 'object' || l === null) return false;
    const memo = (l as { memo?: unknown }).memo;
    return typeof memo === 'string' && memo.trim().length > 0;
  });
}

export async function getUnenrichedAmazonTxns(entity: Entity, token: string, pages = 60): Promise<RampTxn[]> {
  const out: RampTxn[] = [];
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && url; i++) {
    const { status, body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    if (status !== 200) break;
    const rows = body.data ?? [];
    if (!rows.length) break;
    for (const t of rows) {
      if (!isAmazon(t.merchant_name)) continue;
      if (t.sync_status !== 'NOT_SYNC_READY') continue;
      if (isTxnEnriched(t.line_items ?? null)) continue;
      const holder = t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : null;
      out.push({
        id: t.id,
        entity,
        amountCents: Math.round(t.amount * 100),
        date: (t.user_transaction_time ?? '').slice(0, 10),
        cardId: t.card_id ?? null,
        cardHolder: holder || null,
        cardLast4: t.card_last_four ?? null,
        userId: t.card_holder?.user_id ?? null,
        memo: null,
        merchantName: t.merchant_name,
        orderNo: null,
        priorLineItems: t.line_items ?? null,
      });
    }
    url = body.page?.next ?? null;
  }
  return out;
}

export { patchSplit, rampToken } from '../amazon-enrich/client';
