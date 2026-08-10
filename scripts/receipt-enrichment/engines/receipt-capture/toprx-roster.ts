// scripts/receipt-enrichment/engines/receipt-capture/toprx-roster.ts
//
// XHR-vs-DOM decision (Task 4, Step 1 — see fixtures/toprx-roster-probe-raw.json for the
// captured evidence): the order-history grid at /order/history is a server-side Kendo UI grid.
// Page 1 is rendered inline in the HTML with NO XHR, but every subsequent page (and the page-1
// data itself, when re-requested) is served by:
//
//   POST https://b2b.toprx.com/Order/CustomerOrderHistory
//   body: take=<n>&skip=<n>&page=<n>&pageSize=<n>   (form-urlencoded)
//   -> { Data: RosterRowRaw[], Total: number, ExtraData, Errors, CustomProperties } (the wire
//      response also carries ExtraData/Errors — not modeled below since nothing here reads them)
//
// This is a clean, structured JSON source — far more robust than scraping the rendered
// <table>, which additionally is NOT scoped to the order grid alone: the same page also
// renders an unrelated "item ePedigree" ledger table further down, so a naive
// `document.querySelectorAll('table tbody tr')` silently picks up both (discovered live:
// 50 real order rows + 50 ePedigree rows, indistinguishable by column count alone at a
// glance). We source the roster from the XHR JSON, replayed via in-page `fetch` (same-origin,
// so the session's auth cookies are sent automatically), not by clicking the pager.
//
// Field notes from the captured payload (see fixtures/toprx-roster-sample.json, 13 live rows):
//   - CreatedOn is already ISO ("2026-02-12T15:27:56") — no MM/DD/YYYY parsing needed.
//   - OrderTotal is a display string ("$947.32" or "($100.00)" for credits/returns).
//   - InvoiceNumber is always blank in observed data; the real invoice number lives in the
//     Invoices[] array (first element), which is also what's rendered as the invoice link
//     in the DOM ("showEmailInvoiceModal(<n>)").
//   - IsOrderTypeCredit is a definitive boolean for return/credit-memo orders (order-ref
//     prefix "GM-" in observed data) — used instead of sniffing the parenthesized total.
//   - Id (numeric) is the real order id used in the Details link (`/orderdetails/<Id>`);
//     CustomOrderNumber ("NO-..."/"GM-...") is a display reference, not the id.
import type { Page } from 'playwright';

export interface RosterRowRaw {
  CustomOrderNumber: string;
  OrderTotal: string;
  IsReturnRequestAllowed: boolean;
  OrderStatus: string;
  PaymentStatus: string;
  ShippingStatus: string;
  CreatedOn: string;
  PurchaseOrderNumber: string;
  EPedigree: string | null;
  InvoiceNumber: string;
  TrackingNumber: string[];
  InvoiceStatus: string;
  IsOrderTypeCredit: boolean;
  Invoices: number[];
  Id: number;
  CustomProperties: Record<string, never>;
}

// ExtraData/Errors are present on the wire but never read here; TS doesn't require declaring
// unused JSON properties, so they're intentionally omitted (zero any/unknown in source).
interface CustomerOrderHistoryResponse {
  Data: RosterRowRaw[];
  Total: number;
  CustomProperties: Record<string, never>;
}

export interface TopRxOrder {
  orderId: string;
  invoiceNumber: string | null;
  date: string;
  totalCents: number;
}

const PAGE_SIZE = 50;
// Hard safety cap on pagination in case a bug (or a site change) breaks the since/Total
// stopping conditions — 456 orders / 50 per page was ~10 pages live, so 100 is generous.
const DEFAULT_MAX_PAGES = 100;
const SETTLE_MS = 1500;

function parseMoneyCents(raw: string): number {
  // Strip $, commas, and parens (parens denote a negative/credit amount in TopRx's display
  // format, e.g. "($100.00)"). IsOrderTypeCredit is the primary signal we filter on, but this
  // stays defensive in case a non-credit row is ever formatted this way.
  const negative = raw.includes('(');
  const cleaned = raw.replace(/[()$,]/g, '');
  const cents = Math.round(Number(cleaned) * 100);
  return negative ? -cents : cents;
}

/**
 * Pure mapping from raw CustomerOrderHistory rows to TopRxOrder. Credit/return rows
 * (IsOrderTypeCredit) are dropped: they represent money coming back, not a purchase with a
 * receipt to capture, so they're out of scope for the receipt-capture pipeline.
 */
export function parseRosterRows(rows: RosterRowRaw[]): TopRxOrder[] {
  const orders: TopRxOrder[] = [];
  for (const row of rows) {
    if (row.IsOrderTypeCredit) continue;
    const invoiceNumber = row.Invoices.length > 0 ? String(row.Invoices[0]) : null;
    orders.push({
      orderId: String(row.Id),
      invoiceNumber,
      date: row.CreatedOn.slice(0, 10),
      totalCents: parseMoneyCents(row.OrderTotal),
    });
  }
  return orders;
}

async function fetchOrderHistoryPage(
  page: Page,
  pageNum: number,
): Promise<CustomerOrderHistoryResponse> {
  return page.evaluate(
    async ({ pageNum, take }: { pageNum: number; take: number }) => {
      const skip = (pageNum - 1) * take;
      const res = await fetch('/Order/CustomerOrderHistory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: `take=${take}&skip=${skip}&page=${pageNum}&pageSize=${take}`,
        credentials: 'same-origin',
      });
      return (await res.json()) as CustomerOrderHistoryResponse;
    },
    { pageNum, take: PAGE_SIZE },
  );
}

/**
 * Pages through TopRx's order-history XHR (newest-first) collecting orders until either the
 * oldest order on a page predates `opts.since`, the server reports no more rows (Total
 * reached), or `opts.maxPages` is hit.
 */
export async function scrapeTopRxRoster(
  page: Page,
  opts: { since: string; maxPages?: number },
): Promise<TopRxOrder[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const allOrders: TopRxOrder[] = [];
  let fetched = 0;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const response = await fetchOrderHistoryPage(page, pageNum);
    const rows = response.Data;
    if (rows.length === 0) break;

    fetched += rows.length;
    allOrders.push(...parseRosterRows(rows));

    const oldestDate = rows[rows.length - 1].CreatedOn.slice(0, 10);
    const hasMore = fetched < response.Total;
    if (oldestDate < opts.since || !hasMore) break;

    await page.waitForTimeout(SETTLE_MS);
  }

  return allOrders;
}
