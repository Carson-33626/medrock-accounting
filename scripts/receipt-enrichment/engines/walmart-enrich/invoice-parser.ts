// Parse Walmart Print-invoice text (from the /orders/{id} print view, captured as PDF then pdf-parse'd)
// into the shared ParsedReceipt. Item rows end with "Qty N $LINETOTAL" (the $ is the line total).
// Totals block: Subtotal, a shipping line (may show a struck price + final), Tax, Driver tip, Total.
import type { ParsedReceipt, ParsedItem } from '../amazon-enrich/receipt-parser';

function toCents(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
// last dollar amount on a line (shipping shows "$9.95 $0" -> take $0, the charged value)
function lastDollarCents(line: string): number {
  const all = line.match(/\$\s?([\d,]+(?:\.\d{2})?)/g);
  if (!all || all.length === 0) return NaN;
  return toCents(all[all.length - 1]);
}

const ITEM_RE = /^(.*\S)\s+Qty\s+(\d+)\s+\$([\d,]+\.\d{2})$/i;

export function parseWalmartInvoice(text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const order = lines.map((l) => /^Order#\s*([\w-]+)/i.exec(l)?.[1]).find(Boolean) ?? null;

  const items: ParsedItem[] = [];
  let taxCents = 0;
  let shippingCents = 0;
  let tipCents = 0;
  for (const l of lines) {
    const item = ITEM_RE.exec(l);
    if (item) {
      const amountCents = toCents(item[3]);
      const desc = item[1].replace(/\s+/g, ' ').trim();
      if (desc && Number.isFinite(amountCents)) items.push({ desc, amountCents });
      continue;
    }
    if (/^Tax\b/i.test(l)) { const c = lastDollarCents(l); if (Number.isFinite(c)) taxCents = c; continue; }
    if (/^Driver tip\b/i.test(l)) { const c = lastDollarCents(l); if (Number.isFinite(c)) tipCents = c; continue; }
    if (/(delivery|shipping|handling)/i.test(l)) { const c = lastDollarCents(l); if (Number.isFinite(c)) shippingCents = c; continue; }
  }

  const parsedTotalCents = items.reduce((a, b) => a + b.amountCents, 0) + taxCents + shippingCents + tipCents;
  return { layout: 'WMT', source: 'walmart', order, glHint: null, items, taxCents, shippingCents, tipCents, parsedTotalCents };
}
