// paths.ts is the single source of truth for cache locations. The 2026-08-07 consolidation showed
// why that matters: the cache was addressed by ~40 literals, and a MISSED one fails silently (a
// runner recreates the directory rather than erroring, and the panel then reads a stale cache).
// These tests pin the invariants that make such a miss detectable.
import { describe, it, expect } from 'vitest';
import { CACHE_ROOT, PROGRAM_ROOT, ENGINES_ROOT, RC, AMZ, ACSV, WM, RSP, sessionPath, txnReportPath, sharedPdfPath, invoicePdfPath } from './paths';

const groups = { RC, AMZ, ACSV, WM, RSP };

describe('paths', () => {
  it('roots everything under the program folder', () => {
    expect(PROGRAM_ROOT).toBe('scripts/receipt-enrichment');
    expect(ENGINES_ROOT).toBe('scripts/receipt-enrichment/engines');
    expect(CACHE_ROOT).toBe('scripts/receipt-enrichment/cache');
  });

  it('keeps every cache path inside CACHE_ROOT', () => {
    for (const [name, group] of Object.entries(groups)) {
      for (const [key, value] of Object.entries(group)) {
        expect(`${name}.${key} -> ${value}`).toContain(CACHE_ROOT);
      }
    }
  });

  it('never leaks a cache path into the engines tree', () => {
    // A cache path under engines/ would mean the consolidation half-happened for that vendor.
    for (const group of Object.values(groups)) {
      for (const value of Object.values(group)) {
        expect(value.startsWith(ENGINES_ROOT)).toBe(false);
      }
    }
  });

  it('uses forward slashes and stays relative to web/', () => {
    for (const group of Object.values(groups)) {
      for (const value of Object.values(group)) {
        expect(value).not.toContain('\\');
        expect(value.startsWith('scripts/')).toBe(true);
      }
    }
  });

  it('builds vendor session paths under the receipt-capture state dir', () => {
    expect(sessionPath('toprx', 'FL')).toBe(`${RC.state}/toprx-FL.json`);
    expect(sessionPath('uline', 'TX')).toBe(`${RC.state}/uline-TX.json`);
  });

  it('builds the Amazon Business transactions-report path per account', () => {
    expect(txnReportPath('FL')).toBe(`${ACSV.out}/FL/transactions.csv`);
  });

  it('keys the shared Amazon invoice cache by order id', () => {
    expect(sharedPdfPath('111-2222222-3333333')).toBe(`${ACSV.sharedPdf}/amazon-111-2222222-3333333.pdf`);
  });

  it('names vendor invoice PDFs vendor-entity-key', () => {
    expect(invoicePdfPath('uline', 'FL', '201471906')).toBe(`${RC.pdf}/uline-FL-201471906.pdf`);
  });

  it('nests pdf and sweep inside the receipt-capture out dir', () => {
    expect(RC.pdf.startsWith(RC.out)).toBe(true);
    expect(RC.sweep.startsWith(RC.out)).toBe(true);
    expect(RC.audit.startsWith(RC.out)).toBe(true);
  });
});
