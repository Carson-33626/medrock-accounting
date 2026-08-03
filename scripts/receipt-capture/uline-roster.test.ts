import { describe, it, expect } from 'vitest';
import { rowsToInvoices, shouldKeepScrolling, type ColumnMap, type ScrollState } from './uline-roster';

// Column layout as read from the live grid header (data-title): Date | Order # | Invoice | ...
const COLS: ColumnMap = { date: 0, orderNumber: 1, invoiceNumber: 2 };

// Verbatim shape of the live ULINE invoiced-orders grid (captured 2026-08-03, FL account).
// The grid is ONE ROW PER PRODUCT LINE and prints the Date only on the first row of each date
// GROUP — every later order on that same day renders an empty Date cell.
const LIVE_ROWS: string[][] = [
  ['07/30/2026', '56927178', '211335739'], // first order of 07/30
  ['', '', '211335739'], // continuation line of the same invoice
  ['', '56900849', '211328943'], // DIFFERENT order, same day -> blank date
  ['', '', '211328943'], // continuation line
  ['07/29/2026', '56815599', '211280578'], // first order of 07/29
  ['', '56780899', '211272041'], // DIFFERENT order, same day -> blank date
  ['', '55584623', '211242714'], // DIFFERENT order, same day -> blank date
];

describe('rowsToInvoices', () => {
  it('gives a later order on the same day the date of its group', () => {
    const invoices = rowsToInvoices(LIVE_ROWS, COLS);
    const inv = invoices.find((i) => i.invoiceNumber === '211328943');
    expect(inv?.date).toBe('2026-07-30');
  });

  it('carries the group date across continuation lines that have no order number', () => {
    const invoices = rowsToInvoices(LIVE_ROWS, COLS);
    // 211272041 and 211242714 both sit below a continuation row of the 07/29 group.
    expect(invoices.find((i) => i.invoiceNumber === '211272041')?.date).toBe('2026-07-29');
    expect(invoices.find((i) => i.invoiceNumber === '211242714')?.date).toBe('2026-07-29');
  });

  it('returns one entry per invoice, not one per product line', () => {
    const invoices = rowsToInvoices(LIVE_ROWS, COLS);
    expect(invoices.map((i) => i.invoiceNumber)).toEqual([
      '211335739',
      '211328943',
      '211280578',
      '211272041',
      '211242714',
    ]);
  });

  it('keeps the first order number seen for an invoice', () => {
    const invoices = rowsToInvoices(LIVE_ROWS, COLS);
    expect(invoices.find((i) => i.invoiceNumber === '211335739')?.orderNumber).toBe('56927178');
  });

  it('leaves the date empty when no dated row precedes the invoice', () => {
    const invoices = rowsToInvoices([['', '56900849', '211328943']], COLS);
    expect(invoices[0]?.date).toBe('');
  });

  it('skips rows with no invoice number', () => {
    const invoices = rowsToInvoices([['07/30/2026', '56927178', '']], COLS);
    expect(invoices).toEqual([]);
  });
});

// The grid has NO pager — it is endless-scroll (verified live 2026-08-03: 100 -> 200 -> 300 -> 400
// -> 500 rows across five scrolls). Treating the absent pager as "end of roster" is what truncated
// the roster to ~6 weeks of a 2-year history.
const BASE: ScrollState = {
  previousRowCount: 100,
  currentRowCount: 200,
  oldestDate: '2026-06-16',
  since: '2025-09-01',
  scrolls: 1,
  maxScrolls: 60,
};

describe('shouldKeepScrolling', () => {
  it('keeps scrolling while rows still grow and the oldest row is newer than --since', () => {
    expect(shouldKeepScrolling(BASE)).toBe(true);
  });

  it('stops when a scroll adds no new rows', () => {
    expect(shouldKeepScrolling({ ...BASE, previousRowCount: 500, currentRowCount: 500 })).toBe(false);
  });

  it('stops once the oldest loaded row predates --since', () => {
    expect(shouldKeepScrolling({ ...BASE, oldestDate: '2025-08-31' })).toBe(false);
  });

  it('keeps scrolling when the oldest loaded row is exactly --since', () => {
    expect(shouldKeepScrolling({ ...BASE, oldestDate: '2025-09-01' })).toBe(true);
  });

  it('stops at the safety cap even while rows are still growing', () => {
    expect(shouldKeepScrolling({ ...BASE, scrolls: 60, maxScrolls: 60 })).toBe(false);
  });

  it('keeps scrolling when no row has yielded a date yet', () => {
    expect(shouldKeepScrolling({ ...BASE, oldestDate: '' })).toBe(true);
  });
});
