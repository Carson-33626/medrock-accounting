// REFRESH: Medisca portal -> local cache. Read-only — touches no system of record, so unlike the
// enrich/create writers this is safe to run freely and on a button.
//
// The cache is the seam. Everything downstream (plan, create) reads it and never touches the vendor,
// which makes planning offline, repeatable and reviewable, and means a portal outage cannot block a
// create run. Write-through on every invoice, so a crash or session expiry keeps what was captured.
import { writeFileSync, mkdirSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { MediscaSession } from './medisca-session';
import { parseInvoiceList, invoiceListPath, isLastPage } from './medisca-invoices';
import type { InvoiceRow } from './medisca-invoices';
import { parseOrderLines } from './medisca-order';
import { parseInvoiceLines, parseInvoiceTotals } from './medisca-invoice';
import { loadBillCache, cacheToCsv } from './bill-cache';
import type { CachedInvoice } from './bill-cache';
import type { Entity } from '../ramp-split-push/types';

const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export interface RefreshOptions {
  entity: Entity;
  /** invoices dated before this are ignored — never capture into a closed period */
  periodFloor: string;
  /** re-fetch invoices already cached */
  force: boolean;
  outDir: string;
  pdfDir: string;
  now: () => string;
}

export interface RefreshResult {
  listed: number;
  fetched: number;
  reused: number;
  failed: number;
  cachePath: string;
  csvPath: string;
}

/**
 * Page until a short page. The portal's default view renders 20 rows and advertises NO next control
 * and NO page numbers, so a single request looks complete while hiding the rest — FL actually has 46
 * unpaid invoices. Trusting one response is the ULINE roster truncation all over again.
 */
export async function listAllInvoices(
  session: MediscaSession,
  paid: boolean,
  periodFloor: string,
  log: (msg: string) => void,
): Promise<InvoiceRow[]> {
  const all: InvoiceRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await session.get(invoiceListPath(paid, PAGE_LIMIT, page));
    const rows = parseInvoiceList(res.text);
    all.push(...rows);
    if (isLastPage(rows, PAGE_LIMIT)) return all;

    // Stop once an ENTIRE page predates the floor. The paid list runs to 1,680 invoices across
    // years while only ~140 are in period, so paging it all is pure waste. Testing the page maximum
    // rather than assuming a sort order means an out-of-order list costs an extra page, not
    // dropped invoices — the conservative direction.
    const newest = rows.reduce((max, r) => (r.invoiceDate > max ? r.invoiceDate : max), '');
    if (newest < periodFloor) {
      log(`    page ${page}: entirely before ${periodFloor}, stopping`);
      return all;
    }
    log(`    page ${page}: ${rows.length} rows (full page, continuing)`);
  }
  // Hitting the cap means there is more data we are not reading. Say so rather than return quietly.
  throw new Error(
    `Medisca ${session.entity}: ${paid ? 'paid' : 'unpaid'} list still full after ${MAX_PAGES} pages ` +
    `(${all.length} rows). Refusing to silently truncate.`,
  );
}

export async function refreshEntity(
  session: MediscaSession,
  opts: RefreshOptions,
  log: (msg: string) => void,
): Promise<RefreshResult> {
  mkdirSync(opts.outDir, { recursive: true });
  mkdirSync(opts.pdfDir, { recursive: true });

  const cachePath = `${opts.outDir}/medisca-cache-${opts.entity}.json`;
  const csvPath = `${opts.outDir}/medisca-cache-${opts.entity}.csv`;
  const cache = loadBillCache(cachePath);

  // Both lists: terms are ACH Autobill, so Medisca can debit an invoice to `paid` without it ever
  // having been a Ramp bill. Scanning unpaid-only would silently miss those.
  const rows: InvoiceRow[] = [];
  for (const paid of [false, true]) {
    const got = await listAllInvoices(session, paid, opts.periodFloor, log);
    log(`  ${paid ? 'paid' : 'unpaid'}: ${got.length} invoice(s)`);
    rows.push(...got);
  }

  const inPeriod = rows.filter((r) => r.invoiceDate >= opts.periodFloor);
  log(`  ${inPeriod.length} of ${rows.length} on or after ${opts.periodFloor}`);

  let fetched = 0;
  let reused = 0;
  let failed = 0;

  for (const row of inPeriod) {
    if (!opts.force && cache.has(row.invoiceNumberRaw)) { reused++; continue; }

    const record: CachedInvoice = {
      invoiceNumber: row.invoiceNumberRaw,
      invoiceNumberRaw: row.invoiceNumberRaw,
      orderNumber: row.orderNumber,
      entity: opts.entity,
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      listTotalCents: row.totalCents,
      listSubtotalCents: row.subtotalCents,
      listBalanceCents: row.balanceCents,
      paid: row.balanceCents === 0,
      lines: [],
      orderLines: [],
      pdfSubtotalCents: 0,
      pdfTotalCents: 0,
      pdfPath: '',
      parseError: null,
      fetchedAt: opts.now(),
    };

    // The order page is fetched FIRST and outside the PDF's try block, because it is useful even
    // when the PDF is unreadable. Every Medisca invoice before 2026-08-03 is an image-only scan with
    // no text layer, and those are exactly the invoices already coded in QuickBooks — so the order
    // page is the only route to the SKU/account pairs the classifier learns from. Fetching it only
    // on the PDF's success path left the SKU map with zero observations.
    try {
      if (row.orderNumber !== '') {
        const page = await session.get(`/dashboard/orders/${row.orderNumber}`);
        record.orderLines = parseOrderLines(page.text).map((o) => ({
          sku: o.sku, name: o.name, amountCents: o.amountCents, lot: o.lot, backOrdered: o.backOrdered,
        }));
      }
    } catch {
      // A missing order page must not cost us the invoice itself.
      record.orderLines = [];
    }

    try {
      const pdf = await session.fetchPdf(row.invoiceNumberRaw);
      const pdfPath = `${opts.pdfDir}/${opts.entity}-${row.invoiceNumberRaw}.pdf`;
      writeFileSync(pdfPath, pdf);
      record.pdfPath = pdfPath;

      const text = (await pdfParse(pdf)).text;
      const totals = parseInvoiceTotals(text);
      const billed = parseInvoiceLines(text);

      // The order page supplies SKU and clean names; the PDF stays authoritative for AMOUNTS,
      // because an order can carry back-ordered lines that were never billed.
      const orderLines = record.orderLines;

      // Join by amount, and only where the amount is unique on BOTH sides. Three glove lines at
      // $120 cannot be told apart, and a guessed SKU would teach the classifier a wrong account.
      const orderCounts = new Map<number, number>();
      for (const o of orderLines) orderCounts.set(o.amountCents, (orderCounts.get(o.amountCents) ?? 0) + 1);
      const billedCounts = new Map<number, number>();
      for (const b of billed) billedCounts.set(b.amountCents, (billedCounts.get(b.amountCents) ?? 0) + 1);

      const byAmount = new Map<number, { desc: string; sku: string }>();
      for (const o of orderLines) {
        if (orderCounts.get(o.amountCents) !== 1) continue;
        if (billedCounts.get(o.amountCents) !== 1) continue;
        byAmount.set(o.amountCents, {
          desc: [o.name, o.lot].filter((s) => s !== '').join(' Lot:'),
          sku: o.sku,
        });
      }

      record.lines = billed.map((l) => {
        const joined = byAmount.get(l.amountCents);
        return {
          desc: joined?.desc ?? l.text,
          amountCents: l.amountCents,
          sku: joined?.sku ?? '',
        };
      });
      // Both anchors are stored raw. The difference between them is NOT labelled here: on a shipping
      // invoice the lines are gross and tie to the subtotal, on a discounted one the discount is
      // already inside the line amounts and they tie to the total. Only the consumer, which can see
      // which anchor the lines match, can say which happened.
      record.pdfSubtotalCents = totals?.subtotalCents ?? 0;
      record.pdfTotalCents = totals?.totalCents ?? 0;
      if (totals === null) record.parseError = 'could not read the PDF totals block';
      else if (billed.length === 0) record.parseError = 'no billed lines parsed';
      fetched++;
    } catch (e: unknown) {
      record.parseError = (e as Error).message;
      failed++;
    }

    cache.put(record);
    // A full-history refresh runs to ~1,700 invoices; without a heartbeat it is indistinguishable
    // from a hang. Every put() is already flushed, so progress shown here is progress kept.
    if ((fetched + failed) % 25 === 0) {
      log(`  ... ${fetched + failed}/${inPeriod.length - reused} fetched (${failed} failed)`);
    }
  }

  const all = cache.all().filter((r) => r.entity === opts.entity);
  writeFileSync(csvPath, cacheToCsv(all));

  return { listed: inPeriod.length, fetched, reused, failed, cachePath, csvPath };
}
