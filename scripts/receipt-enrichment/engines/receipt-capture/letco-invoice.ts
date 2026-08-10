// Pure parser for a Fagron Shop invoice detail page.
//
// Columns are located by HEADER NAME, never by fixed index: the "Status" cell is empty on most
// rows, and a fixed-index reader silently pulls the wrong column. That exact assumption kept the
// ULINE roster broken for months.
//
// Shipping is NOT itemised on the page — it shows only "Subtotal (incl. estimate shipping costs)"
// — so it is derived as (invoice total - sum of line totals). Verified: $5,164.98 - $5,000.00 =
// $164.98, which reproduces the accountant's two-line coding exactly.
import { parseMoneyCents } from './letco-values';

export interface InvoiceLine {
  itemNo: string;
  description: string;
  amountCents: number;
}

export interface ParsedInvoice {
  lines: InvoiceLine[];
  shippingCents: number;
  totalCents: number;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function findItemTable(html: string): string | null {
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    if (/Item No\./i.test(m[0])) return m[0];
  }
  return null;
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1]));
}

export function parseLetcoDetail(html: string, totalCents: number): ParsedInvoice | null {
  const table = findItemTable(html);
  if (table === null) return null;

  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => rowCells(m[1]));
  if (rows.length === 0) return null;

  const header = rows.find((r) => r.some((c) => /^Item No\.$/i.test(c)));
  if (header === undefined) return null;
  const col = (name: RegExp): number => header.findIndex((c) => name.test(c));
  const iItem = col(/^Item No\.$/i);
  const iTitle = col(/^Title$/i);
  const iTotal = col(/^Total$/i);
  if (iItem < 0 || iTitle < 0 || iTotal < 0) return null;

  const lines: InvoiceLine[] = [];
  for (const cells of rows) {
    if (cells === header) continue;
    if (cells.length <= iTotal) continue;
    const itemNo = cells[iItem];
    const amountCents = parseMoneyCents(cells[iTotal]);
    if (itemNo === '' || amountCents === null) continue;
    lines.push({ itemNo, description: cells[iTitle], amountCents });
  }
  if (lines.length === 0) return null;

  const lineTotal = lines.reduce((a, l) => a + l.amountCents, 0);
  const shippingCents = totalCents - lineTotal;
  // A negative residual means the parse or the stated total is wrong. Refuse rather than code it.
  if (shippingCents < 0) return null;

  return { lines, shippingCents, totalCents };
}
