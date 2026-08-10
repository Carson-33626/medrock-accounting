// Parse the Medisca invoice PDF. This is the AUTHORITATIVE record of what was billed — the order
// page is the order, and the two differ whenever anything back-orders (order 04461596 totals $7,785
// against a $3,450 invoice).
//
// We take AMOUNTS and TOTALS from here and nothing else. Descriptions are deliberately not trusted:
// the layout is not stable across invoices (two captured fixtures use different column orders),
// boilerplate interleaves inside item blocks, and on invoice 04245590 the description is truncated
// to "Gloves, Blue Nitrile Powder-Free," with "Safe-Sense", "Non-Sterile" and "4 mil" absent from the
// extracted text entirely. Product identity comes from the order page's SKU instead.
//
// What IS stable is the money column, because pdf-parse emits it as one run:
//     "20PK/100$6.00000$120.00"        -> unit price at 5dp, then the line amount at 2dp
//     "15 g$3,450.00000$3,450.00"
// so amounts are matched on that shape rather than on any column position.

/** Unit price always carries 5 decimals; the line amount immediately follows it with 2. */
const PRICE_LINE_RE = /\$([\d,]+\.\d{5})\$\(?(-?[\d,]+\.\d{2})\)?\s*$/;

function money(text: string): number {
  const digits = text.replace(/[$,\s]/g, '');
  const n = Math.round(Number(digits) * 100);
  return Number.isFinite(n) ? n : 0;
}

export interface ParsedInvoiceLine {
  amountCents: number;
  unitPriceCents: number;
  /** best-effort text from the PDF; lossy by design, used only as a fallback description */
  text: string;
}

export interface ParsedInvoiceTotals {
  subtotalCents: number;
  totalCents: number;
}

/**
 * Lines, in document order. The description is whatever plain text immediately precedes the price
 * run, minus lot/stock-code noise — good enough to fall back on, never good enough to rely on.
 */
export function parseInvoiceLines(text: string): ParsedInvoiceLine[] {
  const lines = text.split('\n').map((l) => l.trim());
  const out: ParsedInvoiceLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = PRICE_LINE_RE.exec(lines[i]);
    if (m === null) continue;

    // Walk back for the nearest human-looking line: skip lot/expiry rows, bare numbers, stock codes
    // and Medisca's boilerplate, which really does appear mid-item block.
    let desc = '';
    for (let j = i - 1; j >= 0 && j > i - 6; j--) {
      const c = lines[j];
      if (c === '') continue;
      if (/^Lot:/i.test(c)) continue;
      if (/^[\d\s.,\-/]+$/.test(c)) continue;
      if (/^\*?C of A available/i.test(c)) continue;
      if (/^Medisca Inc\./i.test(c)) continue;
      if (c.length > 120) continue;
      desc = c;
      break;
    }

    out.push({
      amountCents: money(m[2]),
      unitPriceCents: money(m[1]),
      text: desc.replace(/,\s*$/, '').trim(),
    });
  }
  return out;
}

/**
 * The totals block is two lines:
 *     "SUB-TOTALDISCOUNTOTHER CHARGESSHIPPING CHARGESTOTAL AMOUNT"
 *     "$360.00$0.00($10.00)$350.00"
 * Note there are FIVE headers but only FOUR values — Medisca omits its zero columns, and which ones
 * are omitted varies. So only the anchors are read: the first value is the subtotal and the last is
 * the total. Everything between is recovered by subtraction downstream, which is exact.
 */
export function parseInvoiceTotals(text: string): ParsedInvoiceTotals | null {
  const lines = text.split('\n').map((l) => l.trim());
  const header = lines.findIndex((l) => /SUB-?TOTAL/i.test(l) && /TOTAL AMOUNT/i.test(l));
  if (header < 0) return null;

  for (let i = header + 1; i < Math.min(lines.length, header + 4); i++) {
    const values = [...lines[i].matchAll(/\(?\$([\d,]+\.\d{2})\)?/g)];
    if (values.length < 2) continue;
    const amount = (m: RegExpMatchArray): number => {
      const v = money(m[1]);
      return m[0].startsWith('(') ? -v : v;
    };
    return {
      subtotalCents: amount(values[0]),
      totalCents: amount(values[values.length - 1]),
    };
  }
  return null;
}
