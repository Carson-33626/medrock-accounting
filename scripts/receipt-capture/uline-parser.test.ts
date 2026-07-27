import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseUlineInvoice, enrichCategories } from './uline-parser';
import type { UlineCsvRow } from './uline-parser';

const text = readFileSync(join(__dirname, 'fixtures', 'uline-invoice-sample.txt'), 'utf8');

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
});
