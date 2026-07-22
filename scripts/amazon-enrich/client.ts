// Amazon-enrich Ramp client: read Amazon txns + receipts, and the ONE write method (PATCH split).
// Reuses the committed ramp-split-push token/get helpers; adds receipt fetch + split write.
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://api.ramp.com/developer/v1';

export interface EligibleTxn {
  id: string;
  entity: Entity;
  amountCents: number;
  date: string;
  cardHolder: string | null;
  merchantName: string | null;
  receiptId: string | null;
  priorLineItems: unknown; // snapshot for audit/rollback
}

interface RawSelection { external_id?: string; category_info?: { external_id?: string } }
interface RawLine { accounting_field_selections?: RawSelection[]; memo?: string | null }
interface RawTxn {
  id: string;
  amount: number;
  user_transaction_time?: string;
  merchant_name: string | null;
  sync_status?: string;
  card_holder?: { first_name?: string; last_name?: string } | null;
  line_items?: RawLine[];
  receipts?: string[];
}
interface Page { data: RawTxn[]; page?: { next?: string } }

function isAmazon(name: string | null): boolean {
  return /amazon/i.test(name ?? '');
}

// Already enriched by us = either a real multi-line split, OR a single line that carries a product
// memo. Ramp seeds ONE default line with memo:null, and our single-item splits also produce ONE line
// but WITH a product-name memo — so line count alone can't tell them apart (that re-processed 145 of
// our 170 prior writes). Memo presence is the reliable signal; erring toward "skip if memo present"
// is the safe direction (worst case we skip a txn, never re-split one).
function isEnriched(t: RawTxn): boolean {
  const lines = t.line_items ?? [];
  if (lines.length > 1) return true;
  return lines.some((l) => (l.memo ?? '').trim().length > 0);
}

// Eligible = a target-merchant txn we haven't enriched, not yet pushed to QB (re-coding a synced txn
// would re-post), with a receipt to parse. `matchMerchant` defaults to Amazon-only for back-compat;
// pass `isBasketMerchant` (Track A) to cover the wider basket-vendor allowlist.
function isEligible(t: RawTxn, matchMerchant: (name: string | null) => boolean): boolean {
  const notEnriched = !isEnriched(t);
  const notSynced = t.sync_status === 'NOT_SYNC_READY';
  const hasReceipt = (t.receipts?.length ?? 0) > 0;
  return matchMerchant(t.merchant_name) && notEnriched && notSynced && hasReceipt;
}

export async function getEligibleAmazonTxns(
  entity: Entity,
  token: string,
  pages = 30,
  matchMerchant: (name: string | null) => boolean = isAmazon,
): Promise<EligibleTxn[]> {
  const out: EligibleTxn[] = [];
  let url: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < pages && url; i++) {
    const { status, body }: { status: number; body: Page } = await rampGet<Page>(entity, url, token);
    if (status !== 200) break;
    const rows = body.data ?? [];
    if (!rows.length) break;
    for (const t of rows) {
      if (!isEligible(t, matchMerchant)) continue;
      const h = t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : null;
      out.push({
        id: t.id,
        entity,
        amountCents: Math.round(t.amount * 100),
        date: (t.user_transaction_time ?? '').slice(0, 10),
        cardHolder: h || null,
        merchantName: t.merchant_name,
        receiptId: t.receipts?.[0] ?? null,
        priorLineItems: t.line_items ?? null,
      });
    }
    url = body.page?.next ?? null;
  }
  return out;
}

export async function getReceiptUrl(entity: Entity, receiptId: string, token: string): Promise<string | null> {
  const { status, body } = await rampGet<{ receipt_url?: string }>(entity, `/receipts/${receiptId}`, token);
  if (status !== 200) return null;
  return body.receipt_url ?? null;
}

// Ramp's own OCR — extracted line items + taxes. Populated on ~all Amazon receipts (PDF AND image)
// via the `include_ocr_data=true` query param. Free (we pay for Ramp); closes the image-receipt gap.
export interface OcrLine {
  item_name: string | null;
  item_quantity: number | null;
  item_unit_price: number | null;
  item_total_price: number | null;
  item_date: string | null;
}
export interface OcrData {
  currency_code: string | null;
  line_items: OcrLine[];
  taxes: { tax_amount: number | null; tax_name?: string | null; tax_rate?: number | null }[];
}
export interface ReceiptMeta {
  url: string | null;
  ext: string;
  ocr: OcrData | null;
}

export async function getReceipt(entity: Entity, receiptId: string, token: string): Promise<ReceiptMeta> {
  const { status, body } = await rampGet<{ receipt_url?: string; ocr?: OcrData | null }>(
    entity,
    `/receipts/${receiptId}?include_ocr_data=true`,
    token,
  );
  if (status !== 200) return { url: null, ext: 'none', ocr: null };
  const url = body.receipt_url ?? null;
  return { url, ext: url ? receiptExt(url) : 'none', ocr: body.ocr ?? null };
}

export function receiptExt(url: string): string {
  return (url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? 'none').toLowerCase();
}

export async function downloadReceipt(url: string, timeoutMs = 25000): Promise<Buffer> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`receipt download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export interface PatchLine {
  amount: number; // minor units (cents)
  memo: string | null;
  accounting_field_selections: { field_external_id: string; field_option_external_id: string }[];
}

// The single write: replace the txn's line_items with the itemized split. Returns status+body
// for the audit row. Rollback = call with lines: [].
export async function patchSplit(
  entity: Entity,
  txnId: string,
  lines: PatchLine[],
  token: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/transactions/${txnId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ line_items: lines }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Set the transaction-level memo (separate PATCH from the split so a memo failure never breaks the
// itemized line_items write). Ramp's txn object carries a top-level `memo` string; format mirrors
// ramp-split-push's buildMemo: "Amazon order# <order> (<N> items)".
export async function patchMemo(
  entity: Entity,
  txnId: string,
  memo: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  void entity; // entity is encoded in the token; kept for call-site symmetry
  const res = await fetch(`${BASE}/transactions/${txnId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ memo }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export { rampToken, BASE };
