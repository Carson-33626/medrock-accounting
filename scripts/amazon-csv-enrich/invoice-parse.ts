// Parse the text of a genuine Amazon "order-document.pdf" invoice into structured line items + totals.
// The PDF is Amazon's own printable invoice (fetched via invoice-fetch.fetchRealInvoice); its text layer
// lays each item out as:  "<qty> of: <title...maybe multi-line...>  Sold by ...(optional)  Condition: ...  $<price>"
// followed by per-shipment and order totals. All amounts are pre-tax item prices (Amazon's "Item Subtotal").
export interface ParsedInvoiceItem { desc: string; amountCents: number; qty: number }
export interface ParsedInvoice {
  items: ParsedInvoiceItem[];
  itemsSubtotalCents: number;   // Σ item LINE totals (qty x unit)
  statedSubtotalCents: number;  // the invoice's own "Item(s) Subtotal" (parse cross-check)
  shipmentTotalsCents: number[]; // each "Total for This Shipment" (one per charge on split orders)
  grandTotalCents: number;      // "Grand Total" (= charge for single-charge orders)
  cardLast4: string | null;
}

function moneyToCents(s: string): number { return Math.round(parseFloat(s.replace(/[$,]/g, '')) * 100); }

// Collapse the raw title capture (may span lines and include the "Sold by ..." tail) to a clean product name.
function cleanTitle(raw: string): string {
  let t = raw.replace(/\r/g, ' ').replace(/\n/g, ' ');
  const soldBy = t.search(/Sold by\b/i);
  if (soldBy !== -1) t = t.slice(0, soldBy);
  return t.replace(/\s+/g, ' ').trim();
}

export function parseInvoiceText(text: string): ParsedInvoice {
  const items: ParsedInvoiceItem[] = [];
  // "<qty> of: <title>...Condition:...$<price>"  (title non-greedy up to Condition; price right after)
  const itemRe = /(\d+)\s+of:\s*([\s\S]*?)Condition:[^$]*?\$([\d,]+\.\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(text)) !== null) {
    const qty = parseInt(m[1], 10) || 1;
    const unitCents = moneyToCents(m[3]);            // the price shown is PER UNIT
    const amountCents = unitCents * qty;             // line total = qty x unit
    const desc = cleanTitle(m[2]);
    if (desc) items.push({ desc: qty > 1 ? `${desc} (x${qty})` : desc, amountCents, qty });
  }
  const itemsSubtotalCents = items.reduce((s, it) => s + it.amountCents, 0);
  const statedSub = /Item\(s\) Subtotal:\s*\$([\d,]+\.\d{2})/.exec(text);
  const statedSubtotalCents = statedSub ? moneyToCents(statedSub[1]) : 0;

  const shipmentTotalsCents: number[] = [];
  const shipRe = /Total for This Shipment:\s*\$([\d,]+\.\d{2})/g;
  while ((m = shipRe.exec(text)) !== null) shipmentTotalsCents.push(moneyToCents(m[1]));

  const grand = /Grand Total:\s*\$([\d,]+\.\d{2})/.exec(text);
  const grandTotalCents = grand ? moneyToCents(grand[1]) : 0;
  const last4 = /Last digits:\s*(\d{4})/.exec(text) ?? /ending in\s*(\d{4})/.exec(text);

  return { items, itemsSubtotalCents, statedSubtotalCents, shipmentTotalsCents, grandTotalCents, cardLast4: last4 ? last4[1] : null };
}
