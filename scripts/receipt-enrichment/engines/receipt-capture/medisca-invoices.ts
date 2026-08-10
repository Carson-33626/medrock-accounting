// Parse the Medisca portal's invoice-list table (/dashboard/invoices/{unpaid,paid}-invoices).
//
// The page is plain server-rendered HTML, so no browser is needed. Two traps are handled here:
//
// 1. PAGINATION. The default page renders exactly 20 rows and advertises NO next control and NO page
//    numbers — a scraper that reads it looks complete and silently misses the rest. FL actually has
//    46 unpaid invoices. `?limit=N&page=N` both work; callers must page until a short page (see
//    isLastPage). Same class of bug as the ULINE roster truncation.
//
// 2. DATES ARE OFF BY ONE in the attribute. The markup is
//        <time dateTime="2026-08-03T20:00:00-04:00">Aug 4, 2026</time>
//    i.e. UTC midnight of the 4th, serialised in -04:00, so the attribute's DATE COMPONENT reads the
//    3rd while the invoice is genuinely dated the 4th. Reading the attribute naively would post every
//    bill one day early and drag month-end invoices into the wrong period. Converting to UTC recovers
//    the displayed (correct) date.
export interface InvoiceRow {
  invoiceNumberRaw: string;
  orderNumber: string;
  /** ISO yyyy-mm-dd, matching what the portal displays */
  invoiceDate: string;
  dueDate: string;
  subtotalCents: number;
  totalCents: number;
  balanceCents: number;
}

// Fixed column order, asserted against the header row so a vendor-side reshuffle fails loudly
// instead of quietly mapping Balance into Total.
const EXPECTED_HEADERS = ['Invoice No', 'Order NO', 'Invoice Date', 'Due Date', 'Subtotal', 'Total', 'Balance'];
const COL = { invoice: 1, order: 2, invoiceDate: 3, dueDate: 4, subtotal: 5, total: 6, balance: 7 } as const;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMoneyCents(text: string): number {
  const t = text.replace(/\s|\$|,/g, '');
  if (t === '') return 0;
  // Vendors render credits as -$10.00 and occasionally ($10.00).
  const negative = t.startsWith('-') || (t.startsWith('(') && t.endsWith(')'));
  const digits = t.replace(/[^0-9.]/g, '');
  if (digits === '') return 0;
  const cents = Math.round(Number(digits) * 100);
  if (!Number.isFinite(cents)) return 0;
  return negative ? -cents : cents;
}

/**
 * Prefers the machine-readable <time dateTime> attribute, converted to UTC (see trap 2 above), and
 * falls back to the rendered text so a markup change degrades rather than silently returning ''.
 */
export function parseCellDate(cellHtml: string): string {
  const attr = /datetime="([^"]+)"/i.exec(cellHtml);
  if (attr) {
    const d = new Date(attr[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const text = stripTags(cellHtml);
  const parsed = new Date(`${text} UTC`);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
}

export function parseInvoiceList(html: string): InvoiceRow[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  if (rows.length === 0) return [];

  const header = rowCells(rows[0]).map(stripTags);
  const missing = EXPECTED_HEADERS.filter((h) => !header.some((c) => c.toLowerCase() === h.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `Medisca invoice list: unexpected columns — missing ${JSON.stringify(missing)}, saw ${JSON.stringify(header)}. ` +
      `Refusing to parse by position; the layout changed.`,
    );
  }

  const out: InvoiceRow[] = [];
  for (const row of rows.slice(1)) {
    const cells = rowCells(row);
    if (cells.length <= COL.balance) continue;
    const invoiceNumberRaw = stripTags(cells[COL.invoice]);
    if (!/^\d{6,}$/.test(invoiceNumberRaw)) continue;
    out.push({
      invoiceNumberRaw,
      orderNumber: stripTags(cells[COL.order]),
      invoiceDate: parseCellDate(cells[COL.invoiceDate]),
      dueDate: parseCellDate(cells[COL.dueDate]),
      subtotalCents: parseMoneyCents(stripTags(cells[COL.subtotal])),
      totalCents: parseMoneyCents(stripTags(cells[COL.total])),
      balanceCents: parseMoneyCents(stripTags(cells[COL.balance])),
    });
  }
  return out;
}

/** A page shorter than the requested limit is the last one — the portal offers no other signal. */
export function isLastPage(rows: InvoiceRow[], limit: number): boolean {
  return rows.length < limit;
}

export function invoiceListPath(paid: boolean, limit: number, page: number): string {
  const which = paid ? 'paid-invoices' : 'unpaid-invoices';
  return `/dashboard/invoices/${which}?limit=${limit}&page=${page}`;
}
