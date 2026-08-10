import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { parseInvoiceLines, parseInvoiceTotals } from './medisca-invoice';

const FIXTURES = 'scripts/receipt-enrichment/engines/receipt-capture/fixtures';
const GLOVES_PDF = `${FIXTURES}/medisca-invoice-04245590.pdf`;  // 3x $120 less a $10 shipping credit
const BIMA_PDF = `${FIXTURES}/medisca-invoice-04245588.pdf`;    // single $3,450 line, no credit

describe('parseInvoiceTotals', () => {
  it('reads the anchors when a middle column is omitted', () => {
    // FIVE headers, FOUR values — "OTHER CHARGES" is absent. Only first and last are trustworthy.
    const text = [
      'SUB-TOTALDISCOUNTOTHER CHARGESSHIPPING CHARGESTOTAL AMOUNT',
      '$360.00$0.00($10.00)$350.00',
    ].join('\n');
    expect(parseInvoiceTotals(text)).toEqual({ subtotalCents: 36000, totalCents: 35000 });
  });

  it('reads a totals block with no credit at all (three values)', () => {
    const text = [
      'SUB-TOTALDISCOUNTOTHER CHARGESSHIPPING CHARGESTOTAL AMOUNT',
      '$3,450.00$0.00$3,450.00',
    ].join('\n');
    expect(parseInvoiceTotals(text)).toEqual({ subtotalCents: 345000, totalCents: 345000 });
  });

  it('returns null rather than a wrong number when the block is missing', () => {
    expect(parseInvoiceTotals('nothing useful here')).toBeNull();
  });
});

describe('parseInvoiceLines', () => {
  it('takes the amount from the money run, not from a column position', () => {
    const text = ['Gloves, Blue Nitrile Powder-Free,', '20PK/100$6.00000$120.00'].join('\n');
    expect(parseInvoiceLines(text)).toEqual([
      { amountCents: 12000, unitPriceCents: 600, text: 'Gloves, Blue Nitrile Powder-Free' },
    ]);
  });

  it('handles a size that runs into the price, as Bimatoprost does', () => {
    const text = ['Bimatoprost (Frozen)', '15 g$3,450.00000$3,450.00'].join('\n');
    const [line] = parseInvoiceLines(text);
    expect(line.amountCents).toBe(345000);
    expect(line.text).toBe('Bimatoprost (Frozen)');
  });

  it('skips lot rows and bare stock codes when reaching back for a description', () => {
    const text = [
      '2038779-5743-01', 'Lot: 223592/AExp:06/27/30Qty:20', '5743',
      'Gloves, Blue Nitrile Powder-Free,', '20PK/100$6.00000$120.00',
    ].join('\n');
    expect(parseInvoiceLines(text)[0].text).toBe('Gloves, Blue Nitrile Powder-Free');
  });

  it('steps over boilerplate that interleaves INSIDE an item block', () => {
    // This really happens on invoice 04245590's third glove line.
    const text = [
      'Gloves, Blue Nitrile Powder-Free,', '*C of A available at www.medisca.com',
      '20PK/100$6.00000$120.00',
    ].join('\n');
    expect(parseInvoiceLines(text)[0].text).toBe('Gloves, Blue Nitrile Powder-Free');
  });

  it('ignores a total line, which has no 5-decimal unit price', () => {
    expect(parseInvoiceLines('$360.00$0.00($10.00)$350.00')).toEqual([]);
  });
});

const havePdfs = existsSync(GLOVES_PDF) && existsSync(BIMA_PDF);

describe.skipIf(!havePdfs)('against the real invoice PDFs', () => {
  let gloves = '';
  let bima = '';
  beforeAll(async () => {
    gloves = (await pdfParse(readFileSync(GLOVES_PDF))).text;
    bima = (await pdfParse(readFileSync(BIMA_PDF))).text;
  });

  it('finds all three glove lines', () => {
    const lines = parseInvoiceLines(gloves);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.amountCents)).toEqual([12000, 12000, 12000]);
  });

  it('lines sum to the PDF SUB-TOTAL — the gate that catches a dropped line', () => {
    const totals = parseInvoiceTotals(gloves);
    const sum = parseInvoiceLines(gloves).reduce((a, l) => a + l.amountCents, 0);
    expect(totals).not.toBeNull();
    expect(sum).toBe(totals?.subtotalCents);
    expect(sum).toBe(36000);
  });

  it('exposes the shipping credit as total minus subtotal', () => {
    const t = parseInvoiceTotals(gloves);
    // $350 billed on $360 of goods: a -$10 shipping credit, recovered by subtraction rather than by
    // reading the omitted column.
    expect((t?.totalCents ?? 0) - (t?.subtotalCents ?? 0)).toBe(-1000);
  });

  it('reads the single-line invoice with no adjustment', () => {
    const lines = parseInvoiceLines(bima);
    const t = parseInvoiceTotals(bima);
    expect(lines).toHaveLength(1);
    expect(lines[0].amountCents).toBe(345000);
    expect(t).toEqual({ subtotalCents: 345000, totalCents: 345000 });
  });

  it('bills ONLY the shipped Bimatoprost, not the back-ordered one', () => {
    // The order carries $4,335 of back order on top; the invoice must not.
    const sum = parseInvoiceLines(bima).reduce((a, l) => a + l.amountCents, 0);
    expect(sum).toBe(345000);
    expect(sum).not.toBe(778500);
  });

  it('confirms the PDF description really is lossy, justifying the SKU join', () => {
    expect(gloves).not.toMatch(/Safe-Sense/i);
    expect(gloves).not.toMatch(/Non-Sterile/i);
    expect(parseInvoiceLines(gloves)[0].text).toBe('Gloves, Blue Nitrile Powder-Free');
  });
});
