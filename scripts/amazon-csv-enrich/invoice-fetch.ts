// Fetch a single order's invoice as a PDF from its direct Business URL, rendered via raw CDP
// Page.printToPDF (Playwright page.pdf() throws over a CDP-attached headed Chrome). Carson-confirmed URL.
import type { Page } from '@playwright/test';

export function invoiceUrl(orderId: string): string {
  return `https://www.amazon.com/b2b/aba/order-summary/${orderId}.html`;
}

export async function fetchInvoicePdf(page: Page, orderId: string): Promise<Buffer> {
  await page.goto(invoiceUrl(orderId), { waitUntil: 'networkidle' });
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  await cdp.detach().catch(() => undefined);
  return Buffer.from(data, 'base64');
}
