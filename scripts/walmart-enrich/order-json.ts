// Extract a Walmart order's itemization from the order-detail page's __NEXT_DATA__ blob into the
// shared ParsedReceipt. This replaces the PDF/pdf-parse path: the order detail page embeds fully
// structured JSON at props.pageProps.initialData.data.order (server-rendered), which is exact and
// reconciles to the penny — no OCR/PDF text parsing needed.
//
// Shape (validated live against real orders):
//   order.id / order.displayId / order.orderDate
//   order.groups_2101[].items[].{ quantity, productInfo.name, priceInfo.linePrice.value }  (value = LINE total)
//   order.priceDetails.{ subTotal, taxTotal, grandTotal, grandTotalWithTips, driverTip, fees, discounts }.value
import type { ParsedReceipt, ParsedItem } from '../amazon-enrich/receipt-parser';

interface MoneyVal { value?: number | null }
interface WmItem { quantity?: number | null; productInfo?: { name?: string | null } | null; priceInfo?: { linePrice?: MoneyVal | null } | null }
interface WmGroup { items?: WmItem[] | null }
// `fees` and `discounts` are ARRAYS of line entries (e.g. [{label:"Free delivery",value:0},
// {label:"Below order minimum (less than $35)",value:6.99}]) — each with its own value. Summing the
// array is what closes the reconcile gap on delivery/basket/service fees. subTotal + Σfees + tax + tip
// - Σdiscounts = grandTotalWithTips.
interface WmPriceDetails {
  subTotal?: MoneyVal | null; taxTotal?: MoneyVal | null; grandTotal?: MoneyVal | null;
  grandTotalWithTips?: MoneyVal | null; driverTip?: MoneyVal | null;
  fees?: MoneyVal[] | MoneyVal | null; discounts?: MoneyVal[] | MoneyVal | null;
}
export interface WmOrder {
  id?: string | null; displayId?: string | null; orderDate?: string | null;
  itemCount?: number | null; groups_2101?: WmGroup[] | null; priceDetails?: WmPriceDetails | null;
}

function cents(m: MoneyVal | null | undefined): number {
  return m && typeof m.value === 'number' && Number.isFinite(m.value) ? Math.round(m.value * 100) : 0;
}

// Sum a price-detail field that may be an array of line entries, a single {value}, or null.
function sumCents(field: MoneyVal[] | MoneyVal | null | undefined): number {
  if (Array.isArray(field)) return field.reduce((a, f) => a + cents(f), 0);
  return cents(field);
}

// Pull the order object out of a raw __NEXT_DATA__ script text. Returns null if not present/parseable.
export function extractOrderFromNextData(nextDataText: string): WmOrder | null {
  let data: unknown;
  try { data = JSON.parse(nextDataText); } catch { return null; }
  const order = (((data as Record<string, unknown>)?.props as Record<string, unknown>)?.pageProps as Record<string, unknown>)
    ?.initialData as Record<string, unknown> | undefined;
  const o = (order?.data as Record<string, unknown> | undefined)?.order;
  return o && typeof o === 'object' ? (o as WmOrder) : null;
}

// Map a Walmart order object to the shared ParsedReceipt. Returns null if it has no usable line items.
// parsedTotalCents = Σ line totals + tax + shipping(fees) + tip — the same components buildSplit
// redistributes; the orchestrator's reconcile gate compares this to the Ramp charge to the cent.
export function parseWalmartOrder(order: WmOrder): ParsedReceipt | null {
  const groups = Array.isArray(order.groups_2101) ? order.groups_2101 : [];
  const items: ParsedItem[] = [];
  for (const g of groups) {
    for (const it of (Array.isArray(g?.items) ? g.items : [])) {
      const name = it?.productInfo?.name;
      const amountCents = cents(it?.priceInfo?.linePrice);
      if (typeof name === 'string' && name.trim() && amountCents > 0) items.push({ desc: name.replace(/\s+/g, ' ').trim(), amountCents });
    }
  }
  if (items.length === 0) return null;

  const pd = order.priceDetails ?? {};
  const taxCents = cents(pd.taxTotal);
  const tipCents = cents(pd.driverTip);
  const feesCents = sumCents(pd.fees);          // delivery + basket/below-minimum + service fees
  const discountCents = sumCents(pd.discounts); // order-level promos/discounts (reduce the charge)
  const shippingCents = feesCents;
  const parsedTotalCents = items.reduce((a, b) => a + b.amountCents, 0) + taxCents + shippingCents + tipCents - discountCents;

  return {
    layout: 'WMT', source: 'walmart',
    order: order.displayId ?? order.id ?? null,
    glHint: null, items, taxCents, shippingCents, tipCents, parsedTotalCents,
  };
}

// The amount Walmart actually charged (best reconcile cross-check): grandTotalWithTips, else grandTotal.
export function orderChargeCents(order: WmOrder): number {
  const pd = order.priceDetails ?? {};
  return cents(pd.grandTotalWithTips) || cents(pd.grandTotal);
}
