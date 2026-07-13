import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWalmartInvoice } from './invoice-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(resolve(HERE, 'fixtures/invoice-2000132-07850010.txt'), 'utf8');

describe('parseWalmartInvoice', () => {
  const r = parseWalmartInvoice(sample);

  it('extracts the order number', () => {
    expect(r.order).toBe('2000132-07850010');
  });
  it('extracts 3 item lines with LINE totals', () => {
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.amountCents)).toEqual([20997, 944, 512]);
    expect(r.items[0].desc).toContain('Nitrile Medical Gloves');
  });
  it('reads tax, tip, and discounted shipping (final $0)', () => {
    expect(r.taxCents).toBe(1684);
    expect(r.tipCents).toBe(400);
    expect(r.shippingCents).toBe(0);
  });
  it('reconciles: Σitems + tax + tip + shipping == total', () => {
    expect(r.parsedTotalCents).toBe(24537);
  });
  it('tags layout WMT / source walmart', () => {
    expect(r.layout).toBe('WMT');
    expect(r.source).toBe('walmart');
  });
});
