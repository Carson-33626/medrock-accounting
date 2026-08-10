// Persistent invoice cache for BILL vendors (Medisca, and Letco when it adopts this).
//
// Same write-through contract as walmart-enrich/extraction-store.ts, which TopRx and ULINE share:
// every put() flushes, so a mid-run crash, session expiry or portal rate-limit keeps everything
// already captured. That is what let TopRx's 264-PDF backfill survive restarts.
//
// Bill vendors need their own record because ExtractedOrder is ORDER-shaped — it has tax and tip but
// no due date, order number or paid status, and a draft bill cannot be built without a due date.
//
// The cache is the seam between capture and writing: refresh fills it from the vendor (read-only),
// and plan/create read it without touching the vendor at all.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CachedOrderLine {
  sku: string;
  name: string;
  amountCents: number;
  lot: string;
  /** quantity still back-ordered; a fully back-ordered line was not billed on this invoice */
  backOrdered: number;
}

export interface CachedBillLine {
  desc: string;
  amountCents: number;
  /**
   * Vendor SKU, when the line could be joined unambiguously to the order page. Empty when it could
   * not — several lines sharing one amount (the three $120 gloves) are indistinguishable, and a
   * guessed SKU becomes a wrong GL account on every future invoice carrying it.
   */
  sku: string;
}

export interface CachedInvoice {
  /** normalised invoice number — the dedupe key everywhere (see normalizeInvoiceNumber) */
  invoiceNumber: string;
  /** as printed by the vendor, zero padding intact, for display and attachment naming */
  invoiceNumberRaw: string;
  orderNumber: string;
  entity: string;
  /** ISO date, from the invoice-list row */
  invoiceDate: string;
  dueDate: string;
  /** from the LIST row — the independent second read the reconcile gate cross-checks against */
  listTotalCents: number;
  listSubtotalCents: number;
  listBalanceCents: number;
  paid: boolean;
  /** from the PDF — authoritative for what was BILLED */
  lines: CachedBillLine[];
  /**
   * From the order detail page, stored in its OWN right rather than only as an enrichment of the
   * billed lines. It may include items that were back-ordered and never billed, so it is not a
   * substitute for `lines` — but it is available even when the PDF is an image with no text layer,
   * which every Medisca invoice before 2026-08-03 is. That makes it the only route to SKUs for the
   * historical invoices, and those are precisely the ones already coded in QuickBooks, i.e. the
   * teaching set the SKU map is learned from.
   */
  orderLines: CachedOrderLine[];
  /**
   * The totals block's two anchors, stored raw. Deliberately NOT decomposed into
   * shipping/discount/other: the block omits its zero columns and which ones are omitted varies, and
   * the difference means different things — on a SHIPPING invoice the lines are gross and tie to the
   * subtotal, on a DISCOUNTED one the discount is already inside the line amounts and they tie to
   * the total. Naming the difference "shipping" would assert something the document does not say.
   */
  pdfSubtotalCents: number;
  pdfTotalCents: number;
  pdfPath: string;
  /** null when the PDF parsed cleanly; a reason string when it did not */
  parseError: string | null;
  fetchedAt: string;
}

export interface BillCache {
  has(invoiceNumber: string): boolean;
  get(invoiceNumber: string): CachedInvoice | undefined;
  put(rec: CachedInvoice): void;
  remove(invoiceNumber: string): void;
  all(): CachedInvoice[];
}

/**
 * QuickBooks sometimes drops the vendor's zero padding ("3865107" where the invoice reads
 * "03865107"), so every comparison happens on the stripped form. Measured safe for Medisca: no
 * invoice number appears under more than one entity.
 */
export function normalizeInvoiceNumber(n: string): string {
  return n.trim().replace(/^0+/, '');
}

export function loadBillCache(path: string): BillCache {
  const map = new Map<string, CachedInvoice>();
  if (existsSync(path)) {
    for (const r of JSON.parse(readFileSync(path, 'utf8')) as CachedInvoice[]) {
      map.set(normalizeInvoiceNumber(r.invoiceNumber), r);
    }
  }
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    // Sorted so the file diffs cleanly between refreshes instead of reshuffling.
    const rows = [...map.values()].sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
    writeFileSync(path, JSON.stringify(rows, null, 2));
  };
  return {
    has: (n) => map.has(normalizeInvoiceNumber(n)),
    get: (n) => map.get(normalizeInvoiceNumber(n)),
    put: (rec) => { map.set(normalizeInvoiceNumber(rec.invoiceNumber), rec); flush(); },
    remove: (n) => { if (map.delete(normalizeInvoiceNumber(n))) flush(); },
    all: () => [...map.values()],
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flat dump of the cache so the captured data is reviewable in Excel without reading JSON. The
 * reconcile column is computed here rather than stored, so the export always reflects current rules.
 */
export function cacheToCsv(rows: CachedInvoice[]): string {
  const header = [
    'invoice_number', 'order_number', 'entity', 'invoice_date', 'due_date',
    'list_total', 'balance', 'paid', 'line_count', 'lines_sum',
    'pdf_subtotal', 'pdf_total', 'adjustment', 'ties_to',
    'reconciles', 'parse_error', 'pdf_path', 'fetched_at',
  ].join(',');

  const body = [...rows]
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber))
    .map((r) => {
      const v = reconcileInvoice(r);
      return [
        r.invoiceNumberRaw, r.orderNumber, r.entity, r.invoiceDate, r.dueDate,
        (r.listTotalCents / 100).toFixed(2), (r.listBalanceCents / 100).toFixed(2),
        r.paid ? 'paid' : 'unpaid', String(r.lines.length), (v.linesSumCents / 100).toFixed(2),
        (r.pdfSubtotalCents / 100).toFixed(2), (r.pdfTotalCents / 100).toFixed(2),
        (v.adjustmentCents / 100).toFixed(2), v.tiesTo,
        v.reconciles ? 'yes' : 'NO', r.parseError ?? '', r.pdfPath, r.fetchedAt,
      ].map(csvCell).join(',');
    });

  return [header, ...body].join('\n') + '\n';
}

export interface ReconcileVerdict {
  reconciles: boolean;
  linesSumCents: number;
  /** what a draft would need as an extra line to reach the invoice total */
  adjustmentCents: number;
  /** which anchor the lines tie to: 'subtotal' | 'total' | 'both' | 'neither' */
  tiesTo: string;
}

/**
 * Medisca uses two conventions and they tie to different anchors — see medisca-create.ts. Lines
 * matching NEITHER anchor is the real failure (a dropped or duplicated line); matching either is fine.
 */
export function reconcileInvoice(r: CachedInvoice): ReconcileVerdict {
  const linesSumCents = r.lines.reduce((a, l) => a + l.amountCents, 0);
  const matchesSubtotal = linesSumCents === r.pdfSubtotalCents;
  const matchesTotal = linesSumCents === r.pdfTotalCents;
  const tiesTo = matchesSubtotal && matchesTotal ? 'both'
    : matchesSubtotal ? 'subtotal'
      : matchesTotal ? 'total' : 'neither';
  return {
    reconciles: r.parseError === null
      && r.lines.length > 0
      && (matchesSubtotal || matchesTotal)
      && r.pdfTotalCents === r.listTotalCents,
    linesSumCents,
    adjustmentCents: r.listTotalCents - linesSumCents,
    tiesTo,
  };
}
