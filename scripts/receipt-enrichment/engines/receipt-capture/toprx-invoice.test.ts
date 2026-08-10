import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTopRxInvoice } from './toprx-invoice';

const text = readFileSync(join(__dirname, 'fixtures', 'toprx-invoice-sample.txt'), 'utf8');

describe('parseTopRxInvoice', () => {
  it('parses the sample to items that reconcile with the printed total', () => {
    const parsed = parseTopRxInvoice(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.items.length).toBeGreaterThan(0);
    const sum = parsed!.items.reduce((a, b) => a + b.amountCents, 0) + parsed!.taxCents + parsed!.shippingCents;
    expect(sum).toBe(parsed!.parsedTotalCents);
  });
  it('returns null on unrecognized text', () => {
    expect(parseTopRxInvoice('hello world')).toBeNull();
  });
});
