// Drift guards for the web-side copies of the amazon-enrich receipt helpers (receipt-client.ts,
// ocr-parser.ts, classifier.ts, and the two data/ files). They compare each copy's behavior against
// the receipt-enrichment program's original on the same input, so a future edit to one side doesn't
// silently drift from the other. These guards are the reason the duplication is acceptable — Task 8
// removes them, deliberately, when the program leaves the repo (same as Task 3's ramp.test.ts guard).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseOcr } from './ocr-parser';
import { classify } from './classifier';
import * as receiptClient from './receipt-client';
import type { OcrData, ParsedReceipt } from './receipt-types';

const HERE = dirname(fileURLToPath(import.meta.url));

// Loaded through a non-literal specifier on purpose: a literal `import('../receipt-enrichment/...')`
// here would make tsc resolve ocr-parser.ts's *type-only* import of receipt-parser.ts for type-checking
// — and receipt-parser.ts's pdf-parse import is exactly the TS7016 this whole task removes from the
// root program. A computed specifier keeps this a runtime-only load; Node still resolves it fine.
async function loadOriginalOcrParser(): Promise<{ parseOcr: (ocr: OcrData | null) => ParsedReceipt }> {
  const modulePath = ['..', 'receipt-enrichment', 'engines', 'amazon-enrich', 'ocr-parser'].join('/');
  return (await import(modulePath)) as { parseOcr: (ocr: OcrData | null) => ParsedReceipt };
}

const OCR_FIXTURE: OcrData = {
  currency_code: 'USD',
  line_items: [
    { item_name: 'Nitrile Gloves, Medium', item_quantity: 2, item_unit_price: 12.5, item_total_price: 25, item_date: null },
    { item_name: '  Compounding   Vials  ', item_quantity: null, item_unit_price: null, item_total_price: null, item_date: null },
    { item_name: 'Shipping Label', item_quantity: 1, item_unit_price: null, item_total_price: null, item_date: null }, // no price -> dropped
  ],
  taxes: [{ tax_amount: 1.75, tax_name: 'Sales Tax', tax_rate: null }],
};

const DESCRIPTIONS = [
  'Nitrile Gloves, Medium',
  'Compounding Vials',
  'Shipping Label',
  'Random unmatched gibberish xyz123',
];

describe('receipt-copies drift guard', () => {
  it('parseOcr matches the program original for a representative fixture', async () => {
    const program = await loadOriginalOcrParser();
    expect(parseOcr(OCR_FIXTURE)).toEqual(program.parseOcr(OCR_FIXTURE));
  });

  it('parseOcr matches the program original for null', async () => {
    const program = await loadOriginalOcrParser();
    expect(parseOcr(null)).toEqual(program.parseOcr(null));
  });

  it('classify matches the program original for representative descriptions', async () => {
    const program = await import('../receipt-enrichment/engines/amazon-enrich/classifier');
    for (const desc of DESCRIPTIONS) {
      expect(classify(desc)).toEqual(program.classify(desc));
    }
  });

  it('item_gl_lookup.csv is byte-identical to the program copy', () => {
    const copy = readFileSync(resolve(HERE, 'data/item_gl_lookup.csv'));
    const original = readFileSync(resolve(HERE, '../receipt-enrichment/data/item_gl_lookup.csv'));
    expect(copy.equals(original)).toBe(true);
  });

  it('item_corrections.json is byte-identical to the program copy', () => {
    const copy = readFileSync(resolve(HERE, 'data/item_corrections.json'));
    const original = readFileSync(resolve(HERE, '../receipt-enrichment/data/item_corrections.json'));
    expect(copy.equals(original)).toBe(true);
  });

  // getReceipt performs live Ramp I/O — assert the exported signature exists, nothing more.
  it('exports getReceipt', () => {
    expect(typeof receiptClient.getReceipt).toBe('function');
  });
});
