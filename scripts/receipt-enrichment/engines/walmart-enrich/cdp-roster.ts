// Enumerate the FULL Walmart order roster from the attached real Chrome. The redesigned purchase-history
// page (Next.js + shadow-DOM cards) SSRs only page 1 into __NEXT_DATA__ (phRedesignInitialData); every
// subsequent page loads client-side when you click the "Next page" chevron, which fires a
// `PurchaseHistoryV3` GraphQL call. We seed page 1 from the SSR payload, then click Next and capture each
// GraphQL response until the button disappears (end of history) or we page past the `since` cutoff
// (orders are newest-first). Each order carries id + date + order total — enough to skip old orders
// before the per-order detail fetch, so a backfill of hundreds of orders stays cheap.
import type { Page, Response } from '@playwright/test';
import { isLoginWall } from './session';

export interface RosterEntry { orderId: string; date: string; totalCents: number }

const NEXT_BTN = '[data-automation-id="next-pages-button"]';

function cents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

// Pull { orders, nextCursor } out of a purchaseHistory payload (SSR node OR GraphQL response), wherever
// the `{ orders: [...], pageInfo }` object sits in the object tree.
function extractOrders(root: unknown): { orders: RosterEntry[]; hasNext: boolean } {
  const find = (v: unknown): Record<string, unknown> | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.orders) && o.pageInfo) return o;
    for (const k of Object.keys(o)) { const r = find(o[k]); if (r) return r; }
    return null;
  };
  const ph = find(root);
  if (!ph) return { orders: [], hasNext: false };
  const orders = (ph.orders as Array<Record<string, unknown>>).map((o) => {
    const pd = (o.priceDetails ?? {}) as Record<string, unknown>;
    const ot = (pd.orderTotal ?? {}) as Record<string, unknown>;
    return { orderId: String(o.id ?? ''), date: String(o.orderDate ?? '').slice(0, 10), totalCents: cents(ot.value) };
  }).filter((o) => o.orderId);
  const pi = (ph.pageInfo ?? {}) as { nextPageCursor?: string | null };
  return { orders, hasNext: Boolean(pi.nextPageCursor) };
}

async function readSsrPage1(page: Page): Promise<RosterEntry[]> {
  const nd = await page.evaluate('document.querySelector("script#__NEXT_DATA__")?.textContent || ""') as string;
  let j: unknown;
  try { j = JSON.parse(nd); } catch { return []; }
  return extractOrders(j).orders;
}

export async function scrapeRoster(
  page: Page,
  opts: { since?: string; maxPages?: number } = {},
): Promise<RosterEntry[]> {
  const since = opts.since ?? '0000-01-01';
  const maxPages = opts.maxPages ?? 500;

  // Must be on the purchase-history LIST (/orders) — a detail page (/orders/{id}) also matches a loose
  // "walmart.com/orders" test but its SSR has no purchaseHistory, so pin to the exact list path.
  const onListPage = (() => {
    try { return new URL(page.url()).pathname.replace(/\/+$/, '') === '/orders'; } catch { return false; }
  })();
  if (!onListPage) {
    await page.goto('https://www.walmart.com/orders', { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForTimeout(3500); // let the SPA hydrate
  if (isLoginWall(page.url())) throw new Error('Walmart login wall on /orders — sign in again in Chrome.');

  const byId = new Map<string, RosterEntry>();
  const addPage = (orders: RosterEntry[]): { added: number; allOld: boolean } => {
    let added = 0;
    for (const o of orders) if (!byId.has(o.orderId)) { byId.set(o.orderId, o); added++; }
    const allOld = orders.length > 0 && orders.every((o) => o.date && o.date < since);
    return { added, allOld };
  };

  // Page 1 comes from the server-rendered payload (no GraphQL fired for it).
  const p1 = await readSsrPage1(page);
  if (p1.length === 0) throw new Error('No orders in page-1 SSR payload — page shape changed or not signed in.');
  let { allOld } = addPage(p1);
  console.log(`  roster page 1: ${p1.length} orders (newest ${p1[0].date})`);
  if (allOld) return [...byId.values()];

  // Pages 2..N: click the Next chevron, capture the PurchaseHistoryV3 response it fires.
  for (let p = 2; p <= maxPages; p++) {
    const next = page.locator(NEXT_BTN);
    if (!(await next.count()) || await next.first().isDisabled().catch(() => false)) {
      console.log(`  Next button gone — end of history after ${p - 1} page(s)`);
      break;
    }
    const respP: Promise<Response | null> = page
      .waitForResponse((r) => /\/graphql\/PurchaseHistoryV3\//i.test(r.url()), { timeout: 15000 })
      .catch(() => null);
    await next.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await next.first().click({ timeout: 8000 }).catch((e) => console.log(`  next click err p${p}: ${(e as Error).message.split('\n')[0]}`));
    const resp = await respP;
    if (!resp) { console.log(`  no PurchaseHistoryV3 response on page ${p} — stopping`); break; }

    let text = '';
    try { text = await resp.text(); } catch { console.log(`  page ${p}: response body unreadable — stopping`); break; }
    const { orders } = extractOrders(JSON.parse(text));
    const res = addPage(orders);
    console.log(`  roster page ${p}: ${orders.length} orders${orders[0] ? ` (${orders[orders.length - 1].date}..${orders[0].date})` : ''}, +${res.added} new`);
    if (res.added === 0) { console.log(`  page ${p} added nothing new — stopping (looped/duplicate)`); break; }
    if (res.allOld) { console.log(`  page ${p} entirely before ${since} — stopping backfill`); break; }
    await page.waitForTimeout(400); // gentle pacing
  }

  return [...byId.values()];
}
