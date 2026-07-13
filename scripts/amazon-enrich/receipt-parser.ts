// Parse an Amazon receipt PDF's extracted text into itemized lines. Handles the two live layouts:
//   A) Ramp-generated PDF: "DescriptionQuantityUnit PriceAmount" table, item rows "{qty}${unit}${amount}".
//   B) Amazon order-detail PDF: "N of: <desc>" blocks each closed by a standalone "$price", then subtotals.
// The cent-reconcile gate (Σitems + tax + shipping == txn amount) in the caller is the safety net;
// this parser stays conservative and returns null layout when it can't recognize the format.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export interface ParsedItem {
  desc: string;
  amountCents: number; // pre-tax line amount
}
export interface ParsedReceipt {
  layout: 'A' | 'B' | 'OCR' | 'WMT' | null;
  source: 'ocr' | 'pdf' | 'walmart' | null; // which engine produced this
  order: string | null;
  glHint: string | null; // "GL code: X" embedded on the receipt (order-level hint)
  items: ParsedItem[];
  taxCents: number;
  shippingCents: number;
  tipCents: number; // driver tip etc. — distributed like tax; 0 for Amazon
  parsedTotalCents: number; // Σ item + tax + shipping
}

function toCents(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function findGlHint(lines: string[]): string | null {
  for (const l of lines) {
    const m = /GL code:\s*(.+?)\s*$/i.exec(l);
    if (m) return m[1].trim();
  }
  return null;
}

// ---- Layout A: Ramp-generated PDF ----
function parseA(lines: string[]): ParsedReceipt | null {
  const headerIdx = lines.findIndex((l) => /Description\s*Quantity\s*Unit\s*Price\s*Amount/i.test(l.replace(/\s+/g, ' ')));
  if (headerIdx === -1) return null;
  const order = (() => {
    const i = lines.findIndex((l) => /^Order Number$/i.test(l.trim()));
    return i !== -1 && lines[i + 1] ? lines[i + 1].trim() : null;
  })();

  const items: ParsedItem[] = [];
  let descBuf: string[] = [];
  let taxCents = 0;
  let shippingCents = 0;
  const rowRe = /^(\d+)\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})$/; // qty$unit$amount
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (!l) continue;
    const tax = /^Tax\$?([\d,]+\.\d{2})$/i.exec(l);
    if (tax) { taxCents += toCents(tax[1]); continue; }
    const ship = /^Shipping\$?([\d,]+\.\d{2})$/i.exec(l);
    if (ship) { shippingCents += toCents(ship[1]); continue; }
    if (/^Total:/i.test(l) || /^Taxes:/i.test(l)) break;
    if (/^GL code:/i.test(l)) continue; // captured separately
    const row = rowRe.exec(l);
    if (row) {
      const amountCents = toCents(row[3]);
      const desc = descBuf.join(' ').replace(/\s+/g, ' ').trim();
      if (desc && Number.isFinite(amountCents)) items.push({ desc, amountCents });
      descBuf = [];
      continue;
    }
    descBuf.push(l);
  }
  if (items.length === 0) return null;
  const sum = items.reduce((a, b) => a + b.amountCents, 0) + taxCents + shippingCents;
  return { layout: 'A', source: 'pdf', order, glHint: findGlHint(lines), items, taxCents, shippingCents, tipCents: 0, parsedTotalCents: sum };
}

// ---- Layout B: Amazon order-detail PDF ----
const B_META = /^(Sold by|Business Price|Condition:|Seller Credentials|Supplied by|Shipping Address|FREE|Prime|Gift)/i;
function parseB(lines: string[]): ParsedReceipt | null {
  const hasItems = lines.some((l) => /^\d+ of:/i.test(l.trim()));
  if (!hasItems) return null;
  const order = (() => {
    for (const l of lines) {
      const m = /(?:Details for Order #|Amazon\.com order number:)\s*(\S+)/i.exec(l);
      if (m) return m[1].trim();
    }
    return null;
  })();

  // Collect item blocks: each starts at "N of:" and its price is the first standalone $amount after it.
  const items: ParsedItem[] = [];
  let i = 0;
  const priceRe = /^\$([\d,]+\.\d{2})$/;
  while (i < lines.length) {
    const start = /^(\d+) of:\s*(.*)$/i.exec(lines[i].trim());
    if (!start) { i++; continue; }
    const qty = Number(start[1]);
    const descParts: string[] = start[2] ? [start[2]] : [];
    let amountCents = NaN;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j].trim();
      if (/^\d+ of:/i.test(l)) break; // next item
      if (/Item\(s\) Subtotal/i.test(l)) break; // subtotal section
      const p = priceRe.exec(l);
      if (p) { amountCents = toCents(p[1]); break; }
      if (!B_META.test(l) && l && !/^\$?$/.test(l)) descParts.push(l);
    }
    const desc = descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (desc && Number.isFinite(amountCents)) {
      // The standalone "$price" after an "N of:" block is the UNIT price (verified: $41.97 = 3×$13.99,
      // $297.50 = 10×$29.75). Line total = qty × unit. The reconcile gate catches any exceptions.
      const q = qty > 0 ? qty : 1;
      items.push({ desc, amountCents: amountCents * q });
    }
    i = j;
  }
  if (items.length === 0) return null;

  const grab = (re: RegExp): number => {
    for (const l of lines) {
      const m = re.exec(l.replace(/\s+/g, ' ').trim());
      if (m) return toCents(m[1]);
    }
    return 0;
  };
  // Anchor tax to line-start so "Total before tax:$X" is NOT misread as a tax line.
  const taxCents = grab(/^(?:Sales Tax|Estimated Tax|Tax):\s*\$([\d,]+\.\d{2})/i);
  const shippingCents = grab(/^Shipping & Handling:\s*\$([\d,]+\.\d{2})/i);
  const sum = items.reduce((a, b) => a + b.amountCents, 0) + taxCents + shippingCents;
  return { layout: 'B', source: 'pdf', order, glHint: findGlHint(lines), items, taxCents, shippingCents, tipCents: 0, parsedTotalCents: sum };
}

export async function parseReceiptPdf(bytes: Buffer): Promise<ParsedReceipt> {
  const parsed = await pdfParse(bytes);
  const lines = String(parsed.text ?? '').split('\n');
  return parseA(lines) ?? parseB(lines) ?? {
    layout: null, source: 'pdf', order: null, glHint: null, items: [], taxCents: 0, shippingCents: 0, tipCents: 0, parsedTotalCents: 0,
  };
}
