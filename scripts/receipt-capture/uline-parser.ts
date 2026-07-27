// ULINE invoice PDF parser + CSV category enrichment.
//
// pdf-parse strips column structure the same way it does for TopRx (see toprx-invoice.ts):
// item rows arrive glued with no separator between the qty, unit of measure, item (model) number,
// description, unit price and extended price. The one real layout captured 2026-07-27 (invoice
// 210990196, order 52451456 — see fixtures/uline-invoice-sample.{pdf,txt}) glues them as:
//   "<qty><U/M><model><description>[<continuation lines>]<unitPrice><extendedPrice>"
// e.g. "480EAS-24309AGRADUATED GLASS DROPPER BOTTLES - 1\nOZ, AMBER\n.95456.00" (multi-line item,
// description wraps, the two money values land glued together on their own trailing line) or
// "6CTS-18252SINGLE-USE COLD PACKS - 8 OZ14.0084.00" (single-line item, money glued to the same
// line as the model/description). An item's END is detected structurally, not positionally: lines
// starting at the qty+U/M+model anchor are accumulated until the accumulated text's tail matches
// two adjacent money values (splitItemTail), then qty * unitPriceCents === extendedCents gates the
// split the same way TopRx's splitItemNumbers gates its own ambiguous glued-digit run. Conservative
// throughout: any unrecognized shape returns null immediately; the caller-visible reconcile
// (items + tax + shipping == printed total) is checked against BOTH the printed SUB-TOTAL and the
// final charged total as an extra backstop, since both are independently printed on the invoice.
import type { VendorParsed, VendorItem } from './vendor-split';

export interface UlineCsvRow {
  orderNumber: string;
  category: string;
  model: string;
  description: string;
}

function toCents(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

const MONEY = '(?:\\d{1,3}(?:,\\d{3})*)?\\.\\d{2}';
const TAIL_RE = new RegExp(`(${MONEY})\\s*(${MONEY})\\s*$`);

interface ItemTail { unitPriceCents: number; extendedCents: number; matchStart: number }

// Finds the trailing "<unitPrice><extendedPrice>" pair at the end of the accumulated item text
// (the two values are sometimes glued with no separator, sometimes space-separated — both are
// observed in the one real fixture). Returns the index where the money pair starts so the caller
// can slice off the description before it.
function findItemTail(accumulated: string): ItemTail | null {
  const m = TAIL_RE.exec(accumulated);
  if (!m || m.index === undefined) return null;
  const unitPriceCents = toCents(m[1]);
  const extendedCents = toCents(m[2]);
  if (!Number.isFinite(unitPriceCents) || !Number.isFinite(extendedCents)) return null;
  return { unitPriceCents, extendedCents, matchStart: m.index };
}

// Detects an item's starting line: "<qty 1-5 digits><U/M 2-4 letters, lazy><model + rest of line>".
// U/M is matched lazily with a lookahead for the model's mandatory "S-"/"H-" prefix so it can't
// over-consume into the model code (e.g. "EA" + "S-24309A..." not "EAS" + "-24309A...").
const ITEM_START_RE = /^(\d{1,5})([A-Z]{2,4}?)((?=[SH]-)[SH]-.*)$/;
const MAX_CONTINUATION_LINES = 5;

function parseItems(lines: string[], startIdx: number, endIdx: number): VendorItem[] | null {
  const items: VendorItem[] = [];
  let i = startIdx;
  while (i < endIdx) {
    const m = ITEM_START_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const qty = Number(m[1]);
    const parts: string[] = [m[3]];
    let lastLine = i;
    let tail = findItemTail(parts.join(' '));
    while (!tail) {
      const nextLine = lastLine + 1;
      if (nextLine >= endIdx || nextLine - i >= MAX_CONTINUATION_LINES) return null;
      if (ITEM_START_RE.test(lines[nextLine])) return null; // next item started before this one resolved
      parts.push(lines[nextLine]);
      lastLine = nextLine;
      tail = findItemTail(parts.join(' '));
    }
    if (qty * tail.unitPriceCents !== tail.extendedCents) return null;
    const desc = parts.join(' ').slice(0, tail.matchStart).replace(/\s+/g, ' ').trim();
    if (!desc) return null;
    items.push({ desc, amountCents: tail.extendedCents, category: null });
    i = lastLine + 1;
  }
  return items.length > 0 ? items : null;
}

export function parseUlineInvoice(text: string): VendorParsed | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Multi-anchor gate: all four must be present for this to be recognized as a ULINE invoice.
  const invoiceIdx = lines.findIndex((l) => /^INVOICE #:\s*(\S+)/.test(l));
  const subTotalIdx = lines.findIndex((l) => /^SUB-TOTAL$/i.test(l));
  const taxIdx = lines.findIndex((l) => /^SALES TAX$/i.test(l));
  const shippingIdx = lines.findIndex((l) => /^SHIPPING\/HANDLING$/i.test(l));
  if (invoiceIdx === -1 || subTotalIdx === -1 || taxIdx === -1 || shippingIdx === -1) return null;

  const invoiceMatch = /^INVOICE #:\s*(\S+)/.exec(lines[invoiceIdx]);
  const invoiceNumber = invoiceMatch ? invoiceMatch[1] : null;

  const nextNonBlank = (idx: number): string | null => {
    for (let k = idx + 1; k < lines.length; k++) {
      if (lines[k] !== '') return lines[k];
    }
    return null;
  };

  const subTotalLine = nextNonBlank(subTotalIdx);
  const taxLine = nextNonBlank(taxIdx);
  const shippingLine = nextNonBlank(shippingIdx);
  if (subTotalLine === null || taxLine === null || shippingLine === null) return null;

  const subTotalCents = toCents(subTotalLine);
  const taxCents = toCents(taxLine);
  const shippingCents = toCents(shippingLine);
  if (![subTotalCents, taxCents, shippingCents].every(Number.isFinite)) return null;

  // Final charged total: printed on its own "$XXX.XX" line after "AMOUNT DUE".
  const amountDueIdx = lines.findIndex((l) => /^AMOUNT DUE$/i.test(l));
  if (amountDueIdx === -1) return null;
  let parsedTotalCents: number | null = null;
  for (let k = amountDueIdx + 1; k < lines.length; k++) {
    const m = /^\$([\d,]+\.\d{2})$/.exec(lines[k]);
    if (m) { parsedTotalCents = toCents(m[1]); break; }
  }
  if (parsedTotalCents === null) return null;

  // Items live after the SHIPPING/HANDLING block (invoice prints totals before the item table).
  const items = parseItems(lines, shippingIdx, lines.length);
  if (!items) return null;

  const itemsTotal = items.reduce((a, b) => a + b.amountCents, 0);
  if (itemsTotal !== subTotalCents) return null;

  const sum = itemsTotal + taxCents + shippingCents;
  if (sum !== parsedTotalCents) return null;

  return {
    layout: null,
    source: null,
    order: invoiceNumber,
    glHint: null,
    items,
    taxCents,
    shippingCents,
    tipCents: 0,
    parsedTotalCents,
  };
}

const MIN_DESC_PREFIX_LEN = 8;

function norm(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

// Pure — never mutates `parsed`. Categories are attached in two passes:
//  1. Model-number match: does the invoice item's description contain the CSV row's model number
//     as a substring? (Not strict equality — the invoice text glues the model number directly onto
//     the following description with no separator, e.g. "S-24309AGRADUATED GLASS...", so the model
//     is a prefix/substring of item.desc rather than an isolands token in it.)
//  2. Fallback: case-insensitive description-prefix match — does the item's (whitespace-collapsed)
//     description contain the CSV row's description's leading characters?
// Items with no match keep category: null.
export function enrichCategories(parsed: VendorParsed, csvRows: UlineCsvRow[]): VendorParsed {
  const items: VendorItem[] = parsed.items.map((item) => {
    const descUpper = norm(item.desc);

    const byModel = csvRows.find((r) => {
      const model = norm(r.model);
      return model !== '' && descUpper.includes(model);
    });
    if (byModel) return { ...item, category: byModel.category };

    const byDescPrefix = csvRows.find((r) => {
      const prefix = norm(r.description).slice(0, MIN_DESC_PREFIX_LEN);
      return prefix.length >= MIN_DESC_PREFIX_LEN && descUpper.includes(prefix);
    });
    if (byDescPrefix) return { ...item, category: byDescPrefix.category };

    return item;
  });
  return { ...parsed, items };
}
