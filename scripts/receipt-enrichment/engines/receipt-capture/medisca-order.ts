// Parse the Medisca order detail page (/dashboard/orders/{orderNumber}).
//
// The order page is NOT the invoice. Order 04461596 carries two Bimatoprost lines ($4,335 and
// $3,450) while its invoice 04245588 bills only $3,450 — the rest was back-ordered and shipped
// later. So these lines are NOT the source of truth for what was billed; the invoice PDF is. What
// the order page uniquely provides is the **SKU** and a clean full product name, which the PDF
// either lacks or truncates (invoice 04245590's PDF drops "Safe-Sense", "Non-Sterile" and "4 mil"
// entirely). Lines are joined onto the PDF's amounts downstream.
//
// Two layout facts that rule out positional parsing:
//   * A page can contain SEVERAL product tables (shipped vs back-ordered), each with its own header.
//   * The columns differ between them — "Lot" in one, "Restock ETA" in another — and the leading
//     blank checkbox cell is present in some tables and absent in others, shifting every index.
// So each table is mapped by its OWN header names.
export interface OrderLine {
  sku: string;
  name: string;
  /** quantity ordered */
  qty: number;
  /** quantity still on back order; a line fully back-ordered was not billed on this invoice */
  backOrdered: number;
  unitPriceCents: number;
  amountCents: number;
  lot: string;
}

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => decode(m[1]));
}

function money(text: string): number {
  const t = text.replace(/[$,\s]/g, '');
  if (t === '') return 0;
  const negative = t.startsWith('-') || (t.startsWith('(') && t.endsWith(')'));
  const digits = t.replace(/[^0-9.]/g, '');
  if (digits === '') return 0;
  const n = Math.round(Number(digits) * 100);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

function int(text: string): number {
  const n = Number(text.replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** A SKU looks like "5743-01" / "0008-05" — digits, hyphen, digits. */
const SKU_RE = /^\d{3,}-\d+$/;

interface ColumnMap {
  sku: number;
  name: number;
  qty: number;
  backOrders: number;
  unitPrice: number;
  subtotal: number;
  lot: number;
}

function mapColumns(header: string[]): ColumnMap | null {
  const find = (...names: string[]): number =>
    header.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()));
  const map: ColumnMap = {
    sku: find('Product No'),
    name: find('Product Name'),
    qty: find('Total'),
    backOrders: find('Back Orders'),
    unitPrice: find('Unit Price'),
    subtotal: find('Subtotal'),
    // Absent on back-order tables, which show "Restock ETA" instead. Optional by design.
    lot: find('Lot'),
  };
  // Everything except lot is required; without them we cannot trust positions at all.
  if (map.sku < 0 || map.name < 0 || map.subtotal < 0) return null;
  return map;
}

export function parseOrderLines(html: string): OrderLine[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cells(m[1]));
  const out: OrderLine[] = [];
  let active: ColumnMap | null = null;

  for (const row of rows) {
    // A header row re-maps the columns for every row that follows it, which is what makes a page
    // with several differently-shaped tables parse correctly.
    const asHeader = mapColumns(row);
    if (asHeader !== null && !SKU_RE.test(row[asHeader.sku] ?? '')) {
      active = asHeader;
      continue;
    }
    if (active === null) continue;

    const sku = row[active.sku] ?? '';
    if (!SKU_RE.test(sku)) continue;

    out.push({
      sku,
      name: row[active.name] ?? '',
      qty: int(row[active.qty] ?? ''),
      backOrdered: active.backOrders >= 0 ? int(row[active.backOrders] ?? '') : 0,
      unitPriceCents: active.unitPrice >= 0 ? money(row[active.unitPrice] ?? '') : 0,
      amountCents: money(row[active.subtotal] ?? ''),
      lot: active.lot >= 0 ? (row[active.lot] ?? '') : '',
    });
  }
  return out;
}

/**
 * SKU lookup by line amount, for joining these onto the invoice PDF's authoritative amounts.
 * Amounts that appear more than once on the order are dropped rather than guessed — two lines at the
 * same price are genuinely indistinguishable by amount, and a wrong SKU means a wrong GL account.
 */
export function skuByAmount(lines: OrderLine[]): Map<number, OrderLine> {
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l.amountCents, (counts.get(l.amountCents) ?? 0) + 1);
  const out = new Map<number, OrderLine>();
  for (const l of lines) if (counts.get(l.amountCents) === 1) out.set(l.amountCents, l);
  return out;
}
