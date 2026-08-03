// Pure row->invoice logic for ULINE's invoiced-orders grid. Kept free of Playwright so it can be
// tested against captured grid rows (see uline-roster.test.ts).
//
// The grid renders ONE ROW PER PRODUCT LINE. Two columns are sparse, and they are sparse for
// DIFFERENT reasons — conflating them is what silently dropped 37% of the roster:
//   * Order #  is blank on continuation lines of the SAME order.
//   * Date     is blank on every row after the first of a date GROUP — including the first row of
//              a DIFFERENT order placed the same day. So a blank Date does NOT mean "same order",
//              it means "same day", and the value must be carried down.

export interface UlineInvoice {
  invoiceNumber: string;
  orderNumber: string;
  date: string;
}

export interface ColumnMap {
  date: number;
  orderNumber: number;
  invoiceNumber: number;
}

// MM/DD/YYYY -> YYYY-MM-DD. Anything else is left as-is defensively rather than guessed.
export function normalizeDate(raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : raw.trim();
}

function cell(row: string[], idx: number): string {
  return (row[idx] ?? '').trim();
}

/**
 * Collapse line-granular grid rows to one entry per invoice, carrying each date group's date down
 * to the orders beneath it. Rows are expected in the grid's own top-to-bottom order.
 */
export function rowsToInvoices(rows: string[][], cols: ColumnMap): UlineInvoice[] {
  const byInvoice = new Map<string, UlineInvoice>();
  let carriedDate = '';

  for (const row of rows) {
    const rawDate = cell(row, cols.date);
    if (rawDate !== '') carriedDate = normalizeDate(rawDate);

    const invoiceNumber = cell(row, cols.invoiceNumber);
    const orderNumber = cell(row, cols.orderNumber);
    // A row with no order number is a continuation line; it still belongs to the current date
    // group (already carried above) but carries no new invoice identity of its own.
    if (invoiceNumber === '' || orderNumber === '') continue;
    if (byInvoice.has(invoiceNumber)) continue;

    byInvoice.set(invoiceNumber, { invoiceNumber, orderNumber, date: carriedDate });
  }

  return [...byInvoice.values()];
}

export interface ScrollState {
  previousRowCount: number;
  currentRowCount: number;
  /** Oldest YYYY-MM-DD seen so far, or '' when no row has yielded a date yet. */
  oldestDate: string;
  /** Inclusive lower bound we need the roster to reach. */
  since: string;
  scrolls: number;
  maxScrolls: number;
}

/**
 * The invoiced-orders grid has NO pager — it loads ~100 more line rows per scroll (verified live
 * 2026-08-03). Stop when the list stops growing, when we have reached back past `since`, or at the
 * safety cap. An unknown oldest date is NEVER a reason to stop: rows load before their date group
 * header is reached, so '' means "keep going", not "nothing there".
 */
export function shouldKeepScrolling(s: ScrollState): boolean {
  if (s.scrolls >= s.maxScrolls) return false;
  if (s.currentRowCount <= s.previousRowCount) return false;
  if (s.oldestDate !== '' && s.oldestDate < s.since) return false;
  return true;
}
