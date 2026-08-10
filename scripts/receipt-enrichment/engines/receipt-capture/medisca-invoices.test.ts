import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  parseInvoiceList, parseMoneyCents, parseCellDate, isLastPage, invoiceListPath,
} from './medisca-invoices';

const FIXTURES = 'scripts/receipt-enrichment/engines/receipt-capture/fixtures';
const FULL = `${FIXTURES}/medisca-unpaid-list-FL.html`;
const DEFAULT_PAGE = `${FIXTURES}/medisca-unpaid-list-FL-default.html`;

describe('parseMoneyCents', () => {
  it('parses the portaldollar format', () => {
    expect(parseMoneyCents('$3,450.00')).toBe(345000);
    expect(parseMoneyCents('$60.00')).toBe(6000);
    expect(parseMoneyCents('$0.00')).toBe(0);
  });

  it('parses credits, which Medisca really does emit (the -$10 shipping credit)', () => {
    expect(parseMoneyCents('-$10.00')).toBe(-1000);
    expect(parseMoneyCents('($10.00)')).toBe(-1000);
  });

  it('returns 0 for empty rather than NaN', () => {
    expect(parseMoneyCents('')).toBe(0);
    expect(parseMoneyCents('   ')).toBe(0);
  });
});

describe('parseCellDate', () => {
  it('recovers the DISPLAYED date, not the attribute date', () => {
    // The real markup. The attribute's date component says the 3rd; the invoice is dated the 4th.
    // Reading the attribute naively posts every bill a day early.
    const cell = '<time dateTime="2026-08-03T20:00:00-04:00">Aug 4, 2026</time>';
    expect(parseCellDate(cell)).toBe('2026-08-04');
  });

  it('handles the due-date cell with its extra class attribute', () => {
    expect(parseCellDate('<time class="" dateTime="2026-09-02T20:00:00-04:00">Sep 3, 2026</time>')).toBe('2026-09-03');
  });

  it('falls back to the rendered text when the attribute is gone', () => {
    expect(parseCellDate('<span>Aug 4, 2026</span>')).toBe('2026-08-04');
  });

  it('returns empty rather than a bogus date when unparseable', () => {
    expect(parseCellDate('<span>n/a</span>')).toBe('');
  });
});

describe('parseInvoiceList', () => {
  it('refuses to parse by position when the columns change', () => {
    const html = '<table><tr><th>Invoice No</th><th>Something Else</th></tr></table>';
    expect(() => parseInvoiceList(html)).toThrow(/layout changed/);
  });

  it('returns nothing for an empty document instead of throwing', () => {
    expect(parseInvoiceList('')).toEqual([]);
  });
});

// The fixtures are captured from the live portal by _capture-medisca-fixtures.ts. Skipped rather
// than failed when absent so a fresh clone can still run the suite.
const haveFixtures = existsSync(FULL) && existsSync(DEFAULT_PAGE);

describe.skipIf(!haveFixtures)('parseInvoiceList against the real portal HTML', () => {
  const full = () => parseInvoiceList(readFileSync(FULL, 'utf8'));

  it('parses every row of the full FL unpaid list', () => {
    expect(full()).toHaveLength(46);
  });

  it('PROVES the truncation trap: the default page silently returns 20 of 46', () => {
    const dflt = parseInvoiceList(readFileSync(DEFAULT_PAGE, 'utf8'));
    expect(dflt).toHaveLength(20);
    expect(full().length).toBeGreaterThan(dflt.length);
    // And the default page gives no signal that it is partial — which is exactly why the loader
    // must page until a short page rather than trust one request.
    expect(isLastPage(dflt, 100)).toBe(true);   // it IS short relative to a limit of 100...
    expect(isLastPage(dflt, 20)).toBe(false);   // ...but full relative to the default 20.
  });

  it('reads the first row exactly, dates included', () => {
    expect(full()[0]).toEqual({
      invoiceNumberRaw: '04246911',
      orderNumber: '04559193',
      invoiceDate: '2026-08-04',
      dueDate: '2026-09-03',
      subtotalCents: 6000,
      totalCents: 6000,
      balanceCents: 6000,
    });
  });

  it('reads the known 3-glove invoice and the ruled Bimatoprost invoice', () => {
    const rows = full();
    const gloves = rows.find((r) => r.invoiceNumberRaw === '04245590');
    expect(gloves?.totalCents).toBe(35000);

    const bim = rows.find((r) => r.invoiceNumberRaw === '04245588');
    expect(bim?.totalCents).toBe(345000);
  });

  it('reports a Subtotal already NET of credits — so reconcile must key on Total', () => {
    // Invoice 04245590 is 3x $120 of gloves less a $10 shipping credit. The PDF shows $360 of goods,
    // but the list's Subtotal column reads $350, the same as Total. Treating Subtotal as the sum of
    // goods lines would make every credit-bearing invoice fail reconciliation.
    const gloves = full().find((r) => r.invoiceNumberRaw === '04245590');
    expect(gloves?.subtotalCents).toBe(35000);
    expect(gloves?.subtotalCents).toBe(gloves?.totalCents);
  });

  it('never emits a row without a usable invoice number or date', () => {
    for (const r of full()) {
      expect(r.invoiceNumberRaw).toMatch(/^\d{6,}$/);
      expect(r.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never confuses the order number with the invoice number', () => {
    for (const r of full()) expect(r.orderNumber).not.toBe(r.invoiceNumberRaw);
  });

  it('has a due date after the invoice date on every row (30-day terms)', () => {
    for (const r of full()) expect(r.dueDate > r.invoiceDate).toBe(true);
  });
});

describe('invoiceListPath', () => {
  it('builds both list paths with explicit paging', () => {
    expect(invoiceListPath(false, 100, 1)).toBe('/dashboard/invoices/unpaid-invoices?limit=100&page=1');
    expect(invoiceListPath(true, 100, 2)).toBe('/dashboard/invoices/paid-invoices?limit=100&page=2');
  });
});
