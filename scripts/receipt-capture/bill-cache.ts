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

export interface CachedBillLine {
  desc: string;
  amountCents: number;
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
  /** from the PDF */
  lines: CachedBillLine[];
  shippingCents: number;
  otherChargesCents: number;
  discountCents: number;
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
    'list_subtotal', 'list_total', 'balance', 'paid', 'line_count',
    'lines_sum', 'shipping', 'other_charges', 'discount', 'pdf_total',
    'reconciles', 'parse_error', 'pdf_path', 'fetched_at',
  ].join(',');

  const body = [...rows]
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber))
    .map((r) => {
      const linesSum = r.lines.reduce((a, l) => a + l.amountCents, 0);
      const reconciles = r.parseError === null
        && linesSum + r.shippingCents + r.otherChargesCents - r.discountCents === r.pdfTotalCents
        && r.pdfTotalCents === r.listTotalCents;
      return [
        r.invoiceNumberRaw, r.orderNumber, r.entity, r.invoiceDate, r.dueDate,
        (r.listSubtotalCents / 100).toFixed(2), (r.listTotalCents / 100).toFixed(2),
        (r.listBalanceCents / 100).toFixed(2), r.paid ? 'paid' : 'unpaid', String(r.lines.length),
        (linesSum / 100).toFixed(2), (r.shippingCents / 100).toFixed(2),
        (r.otherChargesCents / 100).toFixed(2), (r.discountCents / 100).toFixed(2),
        (r.pdfTotalCents / 100).toFixed(2),
        reconciles ? 'yes' : 'NO', r.parseError ?? '', r.pdfPath, r.fetchedAt,
      ].map(csvCell).join(',');
    });

  return [header, ...body].join('\n') + '\n';
}
