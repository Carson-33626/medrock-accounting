import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLetcoDetail } from './letco-invoice';

// Real detail page for invoice C335-176896 (fetched live 2026-08-04).
// Roster total was $5,164.98; the single product line is $5,000.00, so shipping is $164.98.
const html = readFileSync(join(__dirname, 'fixtures', 'letco-detail-C335-176896.html'), 'utf8');

describe('parseLetcoDetail', () => {
  it('extracts the product lines', () => {
    const parsed = parseLetcoDetail(html, 516498);
    expect(parsed).not.toBeNull();
    expect(parsed!.lines).toHaveLength(1);
    expect(parsed!.lines[0].itemNo).toBe('697237');
    expect(parsed!.lines[0].description).toContain('TrichoSol');
    expect(parsed!.lines[0].amountCents).toBe(500000);
  });

  it('derives shipping as the gap between the invoice total and the line total', () => {
    const parsed = parseLetcoDetail(html, 516498);
    expect(parsed!.shippingCents).toBe(16498);
  });

  it('reconciles exactly: lines + shipping == total', () => {
    const parsed = parseLetcoDetail(html, 516498);
    const sum = parsed!.lines.reduce((a, l) => a + l.amountCents, 0) + parsed!.shippingCents;
    expect(sum).toBe(parsed!.totalCents);
  });

  it('refuses an invoice whose lines exceed the stated total', () => {
    // A negative shipping residual means the parse or the total is wrong; never code that.
    expect(parseLetcoDetail(html, 100000)).toBeNull();
  });

  it('returns null when no item table is present', () => {
    expect(parseLetcoDetail('<html><body>no table</body></html>', 1000)).toBeNull();
  });
});
