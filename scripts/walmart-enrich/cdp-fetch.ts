// Fetch one Walmart order's itemization from the attached real Chrome: full-navigate to /orders/{id}
// (re-renders the server-side __NEXT_DATA__ for that order), read the embedded order JSON, map it to
// the shared ParsedReceipt. No PDF/OCR — the JSON is exact and reconciles to the penny.
import type { Page } from '@playwright/test';
import { extractOrderFromNextData, parseWalmartOrder, orderChargeCents } from './order-json';
import { isLoginWall } from './session';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';

export interface FetchedOrder { orderId: string; date: string; parsed: ParsedReceipt; chargeCents: number }

export async function fetchOrderJson(page: Page, orderId: string): Promise<FetchedOrder | null> {
  await page.goto(`https://www.walmart.com/orders/${orderId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  if (isLoginWall(page.url())) throw new Error('Walmart login wall — real Chrome session expired; sign in again.');
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (/robot or human|press.*hold|verify you.?re human/i.test(body)) throw new Error('bot challenge on order page — solve it in Chrome, then retry.');

  const nd = await page.evaluate(() => document.querySelector('script#__NEXT_DATA__')?.textContent ?? '');
  const order = nd ? extractOrderFromNextData(nd) : null;
  if (!order) return null;
  const parsed = parseWalmartOrder(order);
  if (!parsed) return null;
  const date = (order.orderDate ?? '').slice(0, 10); // ISO 'YYYY-MM-DD...' -> 'YYYY-MM-DD'
  return { orderId, date, parsed, chargeCents: orderChargeCents(order) };
}

// Fetch many orders through the attached page, gently paced. Stops the batch on a login wall / bot
// challenge (whole session is dead); logs + skips any single order that fails to parse.
export async function fetchOrders(page: Page, orderIds: string[]): Promise<FetchedOrder[]> {
  const out: FetchedOrder[] = [];
  for (const id of orderIds) {
    try {
      const f = await fetchOrderJson(page, id);
      if (f) out.push(f); else console.error(`fetch: order ${id} had no parseable items`);
      await page.waitForTimeout(800); // gentle pacing between navigations
    } catch (e) {
      console.error(`fetch: stopping — ${id}: ${(e as Error).message}`);
      break;
    }
  }
  return out;
}
