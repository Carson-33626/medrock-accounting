import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseUlineInvoice, enrichCategories } from './uline-parser';
import type { UlineCsvRow } from './uline-parser';
import type { VendorParsed } from './vendor-split';

const text = readFileSync(join(__dirname, 'fixtures', 'uline-invoice-sample.txt'), 'utf8');

function emptyParsed(desc: string, amountCents: number): VendorParsed {
  return {
    layout: null,
    source: null,
    order: null,
    glHint: null,
    items: [{ desc, amountCents, category: null }],
    taxCents: 0,
    shippingCents: 0,
    tipCents: 0,
    parsedTotalCents: amountCents,
  };
}

describe('parseUlineInvoice', () => {
  it('items + freight + tax reconcile to the invoice total', () => {
    const parsed = parseUlineInvoice(text);
    expect(parsed).not.toBeNull();
    const sum = parsed!.items.reduce((a, b) => a + b.amountCents, 0) + parsed!.taxCents + parsed!.shippingCents;
    expect(sum).toBe(parsed!.parsedTotalCents);
  });
  it('returns null on unrecognized text', () => {
    expect(parseUlineInvoice('nope')).toBeNull();
  });
});

describe('enrichCategories', () => {
  it('attaches ULINE category by model number match', () => {
    const parsed = parseUlineInvoice(text)!;
    const model = /\b([SH]-\d+[A-Z-]*)\b/.exec(parsed.items[0].desc)?.[1] ?? '';
    const rows: UlineCsvRow[] = [{ orderNumber: 'x', category: 'Jars, Jugs and Bottles', model, description: parsed.items[0].desc }];
    const enriched = enrichCategories(parsed, rows);
    expect(enriched.items[0].category).toBe('Jars, Jugs and Bottles');
  });

  it('matches a model glued directly onto the following description word', () => {
    // Real observed shape: "1EAS-21504FOLDING TABLE .00 .00" parses to desc "S-21504FOLDING TABLE" —
    // the model's containment match must still work even though a letter (not a space) follows it.
    const parsed = emptyParsed('S-21504FOLDING TABLE', 0);
    const rows: UlineCsvRow[] = [{ orderNumber: 'x', category: 'Free Offers', model: 'S-21504', description: 'Folding Table' }];
    expect(enrichCategories(parsed, rows).items[0].category).toBe('Free Offers');
  });

  it('picks the longer of two prefix-colliding model numbers, regardless of csvRows order', () => {
    // S-8324 is a literal prefix of S-83245. A naive first-match containment check would wrongly
    // attach the S-8324 row's category to an item whose real model is S-83245, depending on which
    // row happens to come first. Longest-match-wins must pick S-83245 either way.
    const parsed = emptyParsed('S-83245SOME WIDGET THING', 100);
    const shortModelRow: UlineCsvRow = { orderNumber: 'x', category: 'Labels', model: 'S-8324', description: 'Labels' };
    const longModelRow: UlineCsvRow = { orderNumber: 'x', category: 'Bins and Totes', model: 'S-83245', description: 'Some Widget Thing' };

    expect(enrichCategories(parsed, [shortModelRow, longModelRow]).items[0].category).toBe('Bins and Totes');
    expect(enrichCategories(parsed, [longModelRow, shortModelRow]).items[0].category).toBe('Bins and Totes');
  });
});
