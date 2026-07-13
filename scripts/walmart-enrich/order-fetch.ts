// Fetch one Walmart order's itemized invoice. Navigate to /orders/{id}, render to PDF (the print
// view's text is the format the invoice-parser expects), pdf-parse -> text -> parseWalmartInvoice.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { withWalmartContext, isLoginWall } from './session';
import { buildInvoiceUrl } from './order-id';
import { parseWalmartInvoice } from './invoice-parser';
import type { Page } from '@playwright/test';
import type { ParsedReceipt } from '../amazon-enrich/receipt-parser';

export interface FetchedInvoice { orderId: string; parsed: ParsedReceipt; pdf: Buffer }

export async function fetchInvoice(page: Page, orderId: string): Promise<FetchedInvoice | null> {
  await page.goto(buildInvoiceUrl(orderId), { waitUntil: 'networkidle' });
  if (isLoginWall(page.url())) throw new Error('Walmart session expired — re-run bootstrap-login.ts');
  // Ensure the invoice content is present before rendering (Total is the last block on the invoice).
  await page.waitForFunction(() => /Total/i.test(document.body.innerText), { timeout: 15000 }).catch(() => undefined);
  const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
  const text = String((await pdfParse(pdf)).text ?? '');
  const parsed = parseWalmartInvoice(text);
  if (parsed.items.length === 0) return null;
  return { orderId, parsed, pdf };
}

export async function fetchInvoices(orderIds: string[]): Promise<FetchedInvoice[]> {
  return withWalmartContext(async (page) => {
    const out: FetchedInvoice[] = [];
    for (const id of orderIds) {
      try {
        const f = await fetchInvoice(page, id);
        if (f) out.push(f);
      } catch (e) {
        console.error(`fetchInvoices: order ${id} failed: ${(e as Error).message}`);
        if (isLoginWall(page.url())) {
          console.error('Walmart session expired mid-batch — stopping; re-run bootstrap-login.ts');
          break;
        }
      }
    }
    return out;
  });
}
