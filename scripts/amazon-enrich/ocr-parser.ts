// Map Ramp's own OCR (ocr.line_items + ocr.taxes) into the shared ParsedReceipt shape so it flows
// through the same reconcile -> classify -> split path as the pdf-parse engine. OCR is the PRIMARY
// source (covers PDF and image receipts); pdf-parse is the fallback for PDFs OCR fumbles.
import type { ParsedReceipt, ParsedItem } from './receipt-parser';
import type { OcrData } from './client';

const EMPTY: ParsedReceipt = {
  layout: null, source: 'ocr', order: null, glHint: null, items: [], taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: 0,
};

export function parseOcr(ocr: OcrData | null): ParsedReceipt {
  if (!ocr || !ocr.line_items?.length) return EMPTY;
  const items: ParsedItem[] = [];
  for (const l of ocr.line_items) {
    const desc = (l.item_name ?? '').replace(/\s+/g, ' ').trim();
    // Prefer the extracted line total; else derive from unit * qty.
    let cents = NaN;
    if (l.item_total_price != null) cents = Math.round(l.item_total_price * 100);
    else if (l.item_unit_price != null && l.item_quantity != null) cents = Math.round(l.item_unit_price * l.item_quantity * 100);
    if (desc && Number.isFinite(cents)) items.push({ desc, amountCents: cents });
  }
  if (items.length === 0) return EMPTY;
  const taxCents = (ocr.taxes ?? []).reduce((a, t) => a + (t.tax_amount != null ? Math.round(t.tax_amount * 100) : 0), 0);
  const sum = items.reduce((a, b) => a + b.amountCents, 0) + taxCents;
  // OCR carries no shipping field; a shipping charge (if any) shows up as its own line item.
  return { layout: 'OCR', source: 'ocr', order: null, glHint: null, items, taxCents, shippingCents: 0, tipCents: 0, parsedTotalCents: sum };
}
