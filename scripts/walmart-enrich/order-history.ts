// Scrape the authenticated Walmart order-history roster. toWalmartOrders() is the pure, tested core;
// scrapeOrderHistory() is the thin Playwright wrapper (selectors validated against the captured fixture).
//
// NOTE (deferred live validation): the DOM selectors in scrapeOrderHistory() below (the
// `a[href*="/orders/"]` row selector, the total/date regexes, and the "Next page" pagination
// selector) are the plan's starting point only. They have NOT been confirmed against the live
// Walmart /orders page — Task 8's Step 1 (real fixture capture) and Step 5 (manual smoke against
// the live site) were deliberately deferred because no authenticated Walmart session exists yet.
// Before relying on scrapeOrderHistory() in anger, a human must run the headed bootstrap login,
// capture a real fixture, and validate/adjust these selectors against the live DOM.
import { withWalmartContext, isLoginWall } from './session';
import { normalizeOrderId } from './order-id';
import type { WalmartOrder } from './matcher';

export interface RawHistoryRow { orderId: string; date: string; total: string }

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};
function toIsoDate(s: string): string {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(s);
  if (!m) return '';
  return `${m[3]}-${MONTHS[m[1]] ?? '01'}-${m[2].padStart(2, '0')}`;
}
function toCents(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function toWalmartOrders(rows: RawHistoryRow[]): WalmartOrder[] {
  const seen = new Set<string>();
  const out: WalmartOrder[] = [];
  for (const r of rows) {
    const orderId = normalizeOrderId(r.orderId);
    const totalCents = toCents(r.total);
    if (!orderId || !Number.isFinite(totalCents) || totalCents <= 0) continue;
    if (seen.has(orderId)) continue;
    seen.add(orderId);
    out.push({ orderId, date: toIsoDate(r.date), totalCents });
  }
  return out;
}

export async function scrapeOrderHistory(sinceDate = '2026-01-01', maxPages = 40): Promise<WalmartOrder[]> {
  return withWalmartContext(async (page) => {
    await page.goto('https://www.walmart.com/orders', { waitUntil: 'networkidle' });
    if (isLoginWall(page.url())) throw new Error('Walmart session expired — re-run bootstrap-login.ts');
    const rows: RawHistoryRow[] = [];
    for (let i = 0; i < maxPages; i++) {
      // Selector mirrors the working extraction validated in Step 1 against the live DOM.
      const pageRows: RawHistoryRow[] = await page.evaluate(() => {
        const out: { orderId: string; date: string; total: string }[] = [];
        document.querySelectorAll('a[href*="/orders/"]').forEach((a) => {
          const id = (a.getAttribute('href') || '').split('/orders/')[1]?.split('?')[0] || '';
          const card = a.closest('div');
          const text = card ? card.textContent || '' : '';
          const total = (text.match(/\$\d[\d,]*\.\d{2}/) || [''])[0];
          const date = (text.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/) || [''])[0];
          if (id) out.push({ orderId: id, date, total });
        });
        return out;
      });
      rows.push(...pageRows);
      // History is newest-first: once this whole page is older than `sinceDate`, stop paginating.
      const pageOrders = toWalmartOrders(pageRows);
      const pageMaxDate = pageOrders.reduce((mx, o) => (o.date > mx ? o.date : mx), '');
      if (pageOrders.length > 0 && pageMaxDate < sinceDate) break;
      const next = page.locator('a[aria-label="Next page"], button[aria-label="Next page"]').first();
      if (await next.count() === 0 || !(await next.isEnabled().catch(() => false))) break;
      await next.click();
      await page.waitForLoadState('networkidle');
    }
    return toWalmartOrders(rows).filter((o) => o.date >= sinceDate);
  });
}
