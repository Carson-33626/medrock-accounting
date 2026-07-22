// Fetch a single order's invoice as a PDF from its direct Business URL, rendered via raw CDP
// Page.printToPDF (Playwright page.pdf() throws over a CDP-attached headed Chrome). Carson-confirmed URL.
import type { Page } from '@playwright/test';

export function invoiceUrl(orderId: string): string {
  return `https://www.amazon.com/b2b/aba/order-summary/${orderId}.html`;
}

export async function fetchInvoicePdf(page: Page, orderId: string): Promise<Buffer> {
  await page.goto(invoiceUrl(orderId), { waitUntil: 'networkidle' });

  // Amazon's order-summary is a fixed-width layout that overflows Letter width. preferCSSPageSize let
  // Amazon's own @page size dictate the paper and CLIPPED the right side (only the left portion rendered).
  // Instead: force Letter portrait and scale the content down so its full width fits the printable area.
  const contentPx = await page.evaluate(() => {
    const d = document;
    return Math.max(
      d.body?.scrollWidth ?? 0, d.documentElement?.scrollWidth ?? 0,
      d.body?.offsetWidth ?? 0, d.documentElement?.offsetWidth ?? 0,
    );
  });
  const marginIn = 0.25;
  const paperWidthIn = 8.5;
  const printablePx = (paperWidthIn - marginIn * 2) * 96; // CDP printToPDF uses 96 CSS px per inch
  const scale = contentPx > printablePx ? Math.max(0.1, printablePx / contentPx) : 1;

  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.printToPDF', {
    printBackground: true,
    paperWidth: paperWidthIn,
    paperHeight: 11,
    marginTop: marginIn, marginBottom: marginIn, marginLeft: marginIn, marginRight: marginIn,
    scale,
  });
  await cdp.detach().catch(() => undefined);
  return Buffer.from(data, 'base64');
}
