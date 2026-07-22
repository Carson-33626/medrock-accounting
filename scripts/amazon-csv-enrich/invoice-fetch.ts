// Fetch a single order's GENUINE Amazon invoice. The order-summary URL redirects through print.html to
// Amazon's own "order-document.pdf" (served from documents/download/...). We capture that URL and download
// it via the authenticated request context — a real invoice with a proper text layer, far better than a
// rasterized printToPDF of Chrome's PDF viewer. Returns both the PDF (the receipt) and its extracted text.
import type { Page, Response } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string; numpages: number }>;

export function invoiceUrl(orderId: string): string {
  return `https://www.amazon.com/b2b/aba/order-summary/${orderId}.html`;
}

export interface FetchedInvoice { pdf: Buffer; text: string }

export async function fetchRealInvoice(page: Page, orderId: string, opts: { timeoutMs?: number } = {}): Promise<FetchedInvoice> {
  let pdfUrl = '';
  const onResp = (res: Response): void => {
    if (!pdfUrl && /documents\/download\/.*order-document\.pdf/.test(res.url())) pdfUrl = res.url();
  };
  page.on('response', onResp);
  try {
    await page.goto(invoiceUrl(orderId), { waitUntil: 'networkidle', timeout: opts.timeoutMs ?? 45_000 });
    if (!pdfUrl) await page.waitForTimeout(1500);
    if (!pdfUrl) throw new Error(`order-document.pdf not found for ${orderId} (not visible under active business?)`);
    const resp = await page.request.get(pdfUrl);
    const pdf = await resp.body();
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`order ${orderId}: fetched bytes are not a PDF`);
    let text = '';
    try { text = (await pdfParse(pdf)).text; } catch { text = ''; } // receipt still usable if text parse fails
    return { pdf, text };
  } finally {
    page.off('response', onResp);
  }
}

// Back-compat: just the PDF bytes (the receipt).
export async function fetchInvoicePdf(page: Page, orderId: string): Promise<Buffer> {
  return (await fetchRealInvoice(page, orderId)).pdf;
}
