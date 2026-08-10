// Pure parser for the Sam's Club `getOrder` GraphQL payload -> the same ExtractedOrder shape the Walmart
// cache uses, so everything downstream (matcher, split builder, GL resolution, receipt PDF, write path)
// is shared unchanged. No I/O: the runner hands it a parsed response body.
//
// Field notes, probed live 2026-07-30 (see spec §5a):
//  - items live under `groups_2101[].items[]` (fulfillment groups), name in productInfo.name, line amount
//    in priceInfo.linePrice.value — already net of `savings`.
//  - the CHARGE is `priceDetails.grandTotalWithTips`, NOT `grandTotal`: on a tipped order they differ and
//    grandTotal excludes the tip (in-club 800000053836344: grandTotal 128.50, withTips 139.29, and the
//    Ramp charge is 139.29). `paymentMethods[].displayValues` is wrong there too.
import type { AmazonItem } from '../amazon-csv-enrich/types';

export interface SamsParsedOrder {
  orderId: string;
  date: string;             // 'YYYY-MM-DD'
  chargeCents: number;      // what the card was actually billed (grandTotalWithTips)
  items: AmazonItem[];
  taxCents: number;
  shippingCents: number;    // Σ priceDetails.fees (delivery/express/shipping)
  tipCents: number;
  parsedTotalCents: number; // Σ items + fees + tax + tip — reconciles against chargeCents
}

interface Money { value?: number | null }
interface RawItem {
  productInfo?: { name?: string | null } | null;
  priceInfo?: { linePrice?: Money | null } | null;
}
interface RawGroup { items?: RawItem[] | null }
interface RawPriceDetails {
  taxTotal?: Money | null;
  driverTip?: Money | null;
  grandTotal?: Money | null;
  grandTotalWithTips?: Money | null;
  fees?: ({ label?: string | null } & Money)[] | null;
}
export interface RawSamsOrder {
  id?: string | null;
  orderDate?: string | null;
  itemCount?: number | null;
  priceDetails?: RawPriceDetails | null;
  [key: string]: unknown;    // groups_2101 and friends are read dynamically
}

const cents = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0);

// Group arrays are versioned in the key (`groups_2101`), so match by prefix rather than pinning a
// version that a site update would silently rename.
function groupsOf(order: RawSamsOrder): RawGroup[] {
  const out: RawGroup[] = [];
  for (const [k, v] of Object.entries(order)) {
    if (!/^groups/.test(k) || !Array.isArray(v)) continue;
    for (const g of v as RawGroup[]) if (g && typeof g === 'object') out.push(g);
  }
  return out;
}

export function parseSamsOrder(order: RawSamsOrder | null | undefined): SamsParsedOrder | null {
  if (!order || !order.id || !order.orderDate) return null;
  const pd = order.priceDetails ?? {};

  const items: AmazonItem[] = [];
  for (const g of groupsOf(order)) {
    for (const it of g.items ?? []) {
      const desc = it?.productInfo?.name;
      const amount = it?.priceInfo?.linePrice?.value;
      if (!desc || typeof amount !== 'number') continue;
      items.push({ desc: String(desc), amountCents: cents(amount) });
    }
  }

  const taxCents = cents(pd.taxTotal?.value);
  const tipCents = cents(pd.driverTip?.value);
  const shippingCents = (pd.fees ?? []).reduce((s, f) => s + cents(f?.value), 0);
  // grandTotalWithTips is the billed amount; fall back to grandTotal only when the site omits it.
  const chargeCents = cents(pd.grandTotalWithTips?.value ?? pd.grandTotal?.value);
  const parsedTotalCents = items.reduce((s, i) => s + i.amountCents, 0) + taxCents + shippingCents + tipCents;

  return {
    orderId: String(order.id),
    date: String(order.orderDate).slice(0, 10),
    chargeCents,
    items,
    taxCents,
    shippingCents,
    tipCents,
    parsedTotalCents,
  };
}

// The roster response: fulfillment groups, several per order — dedupe to order ids, newest first.
export interface RawHistory {
  data?: { orderHistoryV2?: { orderGroups?: { orderId?: string | null }[] | null; pageInfo?: { nextPageCursor?: string | null } | null } | null } | null;
}
export function parseSamsRoster(body: RawHistory): { orderIds: string[]; nextCursor: string | null } {
  const h = body?.data?.orderHistoryV2;
  const seen = new Set<string>();
  for (const g of h?.orderGroups ?? []) {
    const id = g?.orderId;
    if (id) seen.add(String(id));
  }
  return { orderIds: [...seen], nextCursor: h?.pageInfo?.nextPageCursor ?? null };
}
