// paths.ts is the single source of truth for cache locations. The 2026-08-07 consolidation showed
// why that matters: the cache was addressed by ~40 literals, and a MISSED one fails silently (a
// runner recreates the directory rather than erroring, and the panel then reads a stale cache).
// These tests pin the invariants that make such a miss detectable.
//
// 2026-08-10: paths became absolute and __dirname-derived. The "relative to web/" test became an
// absoluteness test — the cwd assumption it guarded is the thing that was removed.
import { describe, it, expect } from 'vitest';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_ROOT, PROGRAM_ROOT, ENGINES_ROOT, RC, AMZ, ACSV, WM, RSP, sessionPath, txnReportPath, sharedPdfPath, invoicePdfPath } from './paths';

const HERE = dirname(fileURLToPath(import.meta.url));
const groups = { RC, AMZ, ACSV, WM, RSP };

describe('paths', () => {
  it('roots everything under the program folder', () => {
    expect(PROGRAM_ROOT).toBe(HERE);
    expect(ENGINES_ROOT).toBe(resolve(HERE, 'engines'));
    expect(CACHE_ROOT).toBe(resolve(HERE, 'cache'));
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

  it('is absolute, so no runner depends on its cwd', () => {
    for (const group of Object.values(groups)) {
      for (const value of Object.values(group)) {
        expect(isAbsolute(value)).toBe(true);
      }
    }
  });

  it('never emits a web/-relative literal', () => {
    // A substring search (`.not.toContain`) is the wrong check here: the program folder still
    // physically lives at .../web/scripts/receipt-enrichment until the Task 8 move, so every real
    // absolute path legitimately CONTAINS that substring. What must never happen is a value that
    // IS (or begins as) the old bare, un-resolved relative literal — that's the regression this
    // guards, and it stays meaningful both before and after the folder moves.
    const all = [PROGRAM_ROOT, ENGINES_ROOT, CACHE_ROOT, ...Object.values(groups).flatMap((g) => Object.values(g))];
    for (const v of all) {
      expect(v).not.toBe('scripts/receipt-enrichment');
      expect(v.startsWith('scripts/receipt-enrichment')).toBe(false);
      expect(v.startsWith('scripts\\receipt-enrichment')).toBe(false);
    }
  });

  it('builds vendor session paths under the receipt-capture state dir', () => {
    expect(sessionPath('toprx', 'FL')).toBe(resolve(RC.state, 'toprx-FL.json'));
    expect(sessionPath('uline', 'TX')).toBe(resolve(RC.state, 'uline-TX.json'));
  });

  it('builds the Amazon Business transactions-report path per account', () => {
    expect(txnReportPath('FL')).toBe(resolve(ACSV.out, 'FL', 'transactions.csv'));
  });

  it('keys the shared Amazon invoice cache by order id', () => {
    expect(sharedPdfPath('111-2222222-3333333')).toBe(resolve(ACSV.sharedPdf, 'amazon-111-2222222-3333333.pdf'));
  });

  it('names vendor invoice PDFs vendor-entity-key', () => {
    expect(invoicePdfPath('uline', 'FL', '201471906')).toBe(resolve(RC.pdf, 'uline-FL-201471906.pdf'));
  });

  it('nests pdf and sweep inside the receipt-capture out dir', () => {
    expect(RC.pdf.startsWith(RC.out)).toBe(true);
    expect(RC.sweep.startsWith(RC.out)).toBe(true);
    expect(RC.audit.startsWith(RC.out)).toBe(true);
  });
});
