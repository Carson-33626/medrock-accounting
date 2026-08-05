import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBillCache, normalizeInvoiceNumber, cacheToCsv } from './bill-cache';
import type { CachedInvoice } from './bill-cache';

function invoice(overrides: Partial<CachedInvoice> = {}): CachedInvoice {
  return {
    invoiceNumber: '4245590',
    invoiceNumberRaw: '04245590',
    orderNumber: '04557192',
    entity: 'FL',
    invoiceDate: '2026-08-03',
    dueDate: '2026-09-02',
    listTotalCents: 35000,
    listSubtotalCents: 36000,
    listBalanceCents: 35000,
    paid: false,
    lines: [
      { desc: 'Gloves, Blue Nitrile Powder-Free, (M)', amountCents: 12000 },
      { desc: 'Gloves, Blue Nitrile Powder-Free, (S)', amountCents: 12000 },
      { desc: 'Gloves, Blue Nitrile Powder-Free, (L)', amountCents: 12000 },
    ],
    shippingCents: -1000,
    otherChargesCents: 0,
    discountCents: 0,
    pdfTotalCents: 35000,
    pdfPath: 'out/pdf/medisca/FL-04245590.pdf',
    parseError: null,
    fetchedAt: '2026-08-05T14:00:00.000Z',
    ...overrides,
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'billcache-'));
  path = join(dir, 'nested', 'medisca-cache-FL.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('normalizeInvoiceNumber', () => {
  it('strips the zero padding QuickBooks drops', () => {
    // QB stores "3865107" for the invoice printed as "03865107". Comparing raw would miss the match.
    expect(normalizeInvoiceNumber('03865107')).toBe('3865107');
    expect(normalizeInvoiceNumber('3865107')).toBe('3865107');
    expect(normalizeInvoiceNumber('  04245590 ')).toBe('4245590');
  });

  it('makes the padded and unpadded forms collide', () => {
    expect(normalizeInvoiceNumber('000000004246913')).toBe(normalizeInvoiceNumber('04246913'));
  });
});

describe('loadBillCache', () => {
  it('starts empty when no file exists', () => {
    expect(loadBillCache(path).all()).toEqual([]);
  });

  it('creates the directory and persists on put — write-through, not on exit', () => {
    const cache = loadBillCache(path);
    cache.put(invoice());
    // No flush()/close() call: a crash on the very next line must not lose this record.
    expect(existsSync(path)).toBe(true);
    expect(loadBillCache(path).all()).toHaveLength(1);
  });

  it('survives a simulated crash mid-run, keeping everything already captured', () => {
    const first = loadBillCache(path);
    first.put(invoice({ invoiceNumber: '1', invoiceNumberRaw: '00000001' }));
    first.put(invoice({ invoiceNumber: '2', invoiceNumberRaw: '00000002' }));
    // "Crash": drop the handle entirely and reopen from disk.
    const resumed = loadBillCache(path);
    expect(resumed.all().map((r) => r.invoiceNumber).sort()).toEqual(['1', '2']);
    expect(resumed.has('00000001')).toBe(true);
  });

  it('looks up by padded or unpadded number interchangeably', () => {
    const cache = loadBillCache(path);
    cache.put(invoice({ invoiceNumber: '04245590' }));
    expect(cache.has('4245590')).toBe(true);
    expect(cache.get('04245590')?.orderNumber).toBe('04557192');
  });

  it('replaces rather than duplicates on re-put — a --force refresh must not double the cache', () => {
    const cache = loadBillCache(path);
    cache.put(invoice({ listTotalCents: 35000 }));
    cache.put(invoice({ listTotalCents: 99900 }));
    expect(cache.all()).toHaveLength(1);
    expect(cache.all()[0].listTotalCents).toBe(99900);
  });

  it('removes', () => {
    const cache = loadBillCache(path);
    cache.put(invoice());
    cache.remove('4245590');
    expect(cache.all()).toEqual([]);
    expect(loadBillCache(path).all()).toEqual([]);
  });

  it('writes a stable sorted file so refreshes diff cleanly', () => {
    const cache = loadBillCache(path);
    cache.put(invoice({ invoiceNumber: '9', invoiceNumberRaw: '09' }));
    cache.put(invoice({ invoiceNumber: '1', invoiceNumberRaw: '01' }));
    cache.put(invoice({ invoiceNumber: '5', invoiceNumberRaw: '05' }));
    const order = (JSON.parse(readFileSync(path, 'utf8')) as CachedInvoice[]).map((r) => r.invoiceNumber);
    expect(order).toEqual(['1', '5', '9']);
  });

  it('round-trips a parse failure so a bad PDF is remembered, not silently re-fetched forever', () => {
    const cache = loadBillCache(path);
    cache.put(invoice({ parseError: 'no line rows found', lines: [] }));
    expect(loadBillCache(path).get('4245590')?.parseError).toBe('no line rows found');
  });
});

describe('cacheToCsv', () => {
  it('reconciles a real invoice including its negative shipping credit', () => {
    // 3x $120 gloves less a $10 shipping credit = $350, matching both the PDF and the list row.
    const csv = cacheToCsv([invoice()]);
    const row = csv.trim().split('\n')[1];
    expect(row).toContain('360.00'); // lines_sum
    expect(row).toContain('-10.00'); // shipping credit
    expect(row.split(',')).toContain('yes');
  });

  it('flags an invoice whose lines do not sum to its total', () => {
    const csv = cacheToCsv([invoice({ lines: [{ desc: 'partial', amountCents: 100 }] })]);
    expect(csv.trim().split('\n')[1].split(',')).toContain('NO');
  });

  it('never reconciles a row that failed to parse', () => {
    const csv = cacheToCsv([invoice({ parseError: 'not a PDF' })]);
    expect(csv.trim().split('\n')[1].split(',')).toContain('NO');
  });

  it('quotes descriptions containing commas', () => {
    const csv = cacheToCsv([invoice({ pdfPath: 'a,b.pdf' })]);
    expect(csv).toContain('"a,b.pdf"');
  });

  it('sorts by invoice date so the export reads chronologically', () => {
    const csv = cacheToCsv([
      invoice({ invoiceNumber: '2', invoiceNumberRaw: '02', invoiceDate: '2026-08-04' }),
      invoice({ invoiceNumber: '1', invoiceNumberRaw: '01', invoiceDate: '2026-05-01' }),
    ]);
    const [, first, second] = csv.trim().split('\n');
    expect(first).toContain('2026-05-01');
    expect(second).toContain('2026-08-04');
  });
});
