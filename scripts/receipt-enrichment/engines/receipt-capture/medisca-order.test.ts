import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrderLines, skuByAmount } from './medisca-order';

// FIXTURES feeds existsSync() in THIS test process, which inherits whatever cwd vitest was
// invoked from -- unlike runChild's argv, which always forces cwd: PROGRAM_ROOT. A bare
// program-relative string here is only correct from one of the two cwds the program must run
// from; derived from this file's own location it is correct from both.
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GLOVES = `${FIXTURES}/medisca-order-04557192.html`;   // 3 glove lines, invoice 04245590
const BIMA = `${FIXTURES}/medisca-order-04461596.html`;     // 2 tables, back order, invoice 04245588
const BIG = `${FIXTURES}/medisca-order-04518277.html`;      // 7 lines, invoice 04245589

function table(headers: string[], rows: string[][]): string {
  const tr = (cs: string[], tag: string): string =>
    `<tr>${cs.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return `<table>${tr(headers, 'th')}${rows.map((r) => tr(r, 'td')).join('')}</table>`;
}

describe('parseOrderLines', () => {
  it('maps columns by header name, not position', () => {
    // Leading blank cell present — the shape used by the shipped-items table.
    const html = table(
      ['', 'Product No', 'Product Name', 'Total', 'Back Orders', 'Unit Price', 'Subtotal', 'Lot', ''],
      [['', '5743-01', 'Nitrile Gloves 9" 4mil', '20', '0', '$6.00', '$120.00', '223592/A', '']],
    );
    expect(parseOrderLines(html)).toEqual([{
      sku: '5743-01', name: 'Nitrile Gloves 9" 4mil', qty: 20, backOrdered: 0,
      unitPriceCents: 600, amountCents: 12000, lot: '223592/A',
    }]);
  });

  it('parses the SAME data when the leading blank cell is absent', () => {
    // The back-order table really does drop it, shifting every index by one.
    const html = table(
      ['Product No', 'Product Name', 'Total', 'Back Orders', 'Unit Price', 'Subtotal', 'Restock ETA'],
      [['3066-06', 'Bimatoprost', '5', '5', '$867.00', '$4,335.00', 'Expected in 2 weeks']],
    );
    const [line] = parseOrderLines(html);
    expect(line.sku).toBe('3066-06');
    expect(line.amountCents).toBe(433500);
    expect(line.backOrdered).toBe(5);
    expect(line.lot).toBe('');
  });

  it('re-maps columns at every header, so multi-table pages parse', () => {
    const html =
      table(['Product No', 'Product Name', 'Total', 'Back Orders', 'Unit Price', 'Subtotal', 'Restock ETA'],
        [['3066-06', 'Bimatoprost', '5', '5', '$867.00', '$4,335.00', 'soon']]) +
      table(['', 'Product No', 'Product Name', 'Total', 'Back Orders', 'Unit Price', 'Subtotal', 'Lot', ''],
        [['', '5743-01', 'Gloves', '20', '0', '$6.00', '$120.00', '223592/A', '']]);
    const lines = parseOrderLines(html);
    expect(lines.map((l) => l.sku)).toEqual(['3066-06', '5743-01']);
    expect(lines.map((l) => l.amountCents)).toEqual([433500, 12000]);
  });

  it('ignores rows that are not product lines', () => {
    const html = table(
      ['', 'Product No', 'Product Name', 'Total', 'Back Orders', 'Unit Price', 'Subtotal', 'Lot', ''],
      [
        ['', 'Subtotal', '', '', '', '', '$120.00', '', ''],
        ['', '5743-01', 'Gloves', '20', '0', '$6.00', '$120.00', '223592/A', ''],
      ],
    );
    expect(parseOrderLines(html).map((l) => l.sku)).toEqual(['5743-01']);
  });

  it('returns nothing rather than guessing when no header is recognisable', () => {
    expect(parseOrderLines(table(['A', 'B'], [['5743-01', 'x']]))).toEqual([]);
  });

  it('decodes the escaped inch mark in product names', () => {
    const html = table(
      ['Product No', 'Product Name', 'Subtotal'],
      [['5743-01', 'Nitrile Gloves 9&quot; 4mil', '$120.00']],
    );
    expect(parseOrderLines(html)[0].name).toBe('Nitrile Gloves 9" 4mil');
  });
});

describe('skuByAmount', () => {
  const line = (sku: string, amountCents: number) => ({
    sku, name: sku, qty: 1, backOrdered: 0, unitPriceCents: amountCents, amountCents, lot: '',
  });

  it('indexes unique amounts', () => {
    const idx = skuByAmount([line('a-1', 100), line('b-2', 200)]);
    expect(idx.get(100)?.sku).toBe('a-1');
    expect(idx.get(200)?.sku).toBe('b-2');
  });

  it('DROPS duplicated amounts instead of guessing — a wrong SKU is a wrong GL account', () => {
    // The glove order is exactly this case: three lines at $120.00 each.
    const idx = skuByAmount([line('a-1', 12000), line('b-2', 12000), line('c-3', 12000)]);
    expect(idx.has(12000)).toBe(false);
    expect(idx.size).toBe(0);
  });
});

const haveFixtures = existsSync(GLOVES) && existsSync(BIMA) && existsSync(BIG);

describe.skipIf(!haveFixtures)('against real captured order pages', () => {
  it('reads the three glove lines with their SKUs and lots', () => {
    const lines = parseOrderLines(readFileSync(GLOVES, 'utf8'));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.sku).sort()).toEqual(['5742-01', '5743-01', '5744-01']);
    for (const l of lines) {
      expect(l.amountCents).toBe(12000);
      expect(l.unitPriceCents).toBe(600);
      expect(l.lot).toMatch(/^\d{6}\/[A-Z]$/);
    }
  });

  it('all three gloves cost the same, so SKU-by-amount must refuse them', () => {
    // This is why the join is by amount AND must be unique: $120 maps to three different SKUs here.
    expect(skuByAmount(parseOrderLines(readFileSync(GLOVES, 'utf8'))).size).toBe(0);
  });

  it('reads BOTH tables of the back-ordered Bimatoprost order', () => {
    const lines = parseOrderLines(readFileSync(BIMA, 'utf8'));
    expect(lines.map((l) => l.sku)).toEqual(['3066-06', '3066-03']);
    expect(lines.map((l) => l.amountCents)).toEqual([433500, 345000]);
  });

  it('shows why order lines are NOT the billed lines', () => {
    // Invoice 04245588 bills $3,450. The order totals $7,785 because $4,335 was back-ordered.
    // Using order lines as invoice lines would overstate this bill by more than double.
    const lines = parseOrderLines(readFileSync(BIMA, 'utf8'));
    const orderTotal = lines.reduce((a, l) => a + l.amountCents, 0);
    expect(orderTotal).toBe(778500);
    expect(orderTotal).not.toBe(345000);
  });

  it('reads an 8-line order and ties out to its invoice total exactly', () => {
    const lines = parseOrderLines(readFileSync(BIG, 'utf8'));
    expect(lines).toHaveLength(8);
    // Invoice 04245589 is $15,833.00 and this order was shipped complete.
    expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(1583300);
    expect(lines.every((l) => l.backOrdered === 0)).toBe(true);
  });

  it('indexes the 8-line order cleanly, since its amounts are distinct', () => {
    const idx = skuByAmount(parseOrderLines(readFileSync(BIG, 'utf8')));
    expect(idx.size).toBe(8);
    expect(idx.get(130000)?.sku).toBe('0008-05');
    expect(idx.get(568000)?.sku).toBe('2529-07');
  });

  it('keeps a multi-lot line intact rather than splitting it', () => {
    // "229624/C, 224965/D" is ONE line filled from two lots; it is still one billed amount.
    const line = parseOrderLines(readFileSync(BIG, 'utf8')).find((l) => l.sku === '0008-05');
    expect(line?.lot).toBe('229624/C, 224965/D');
    expect(line?.amountCents).toBe(130000);
  });
});
