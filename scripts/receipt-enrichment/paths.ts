// receipt-enrichment/paths.ts
//
// Single source of truth for every cache location in the program.
//
// Paths are ABSOLUTE, derived from this module's own location. They were relative to `web/` until
// 2026-08-10, which is what tied the program to that cwd — a runner invoked from anywhere else
// silently created a second, empty cache instead of failing. Deriving from __dirname makes the
// program's location the only thing that matters, which is what lets the folder move.
//
// This module performs NO filesystem access, so importing a path never triggers a side effect and
// it is trivially testable.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entity } from './engines/ramp-split-push/types';

export const PROGRAM_ROOT = dirname(fileURLToPath(import.meta.url));
export const ENGINES_ROOT = resolve(PROGRAM_ROOT, 'engines');
export const CACHE_ROOT = resolve(PROGRAM_ROOT, 'cache');

/**
 * receipt-capture: TopRx / ULINE / Letco / Medisca extraction caches, fetched invoice PDFs, the
 * shared append-only audit CSV, and the sweep orchestrator's own output.
 *
 * `state` holds Playwright storageState — LIVE authenticated vendor sessions. Never commit, never
 * copy out of the repo. See the program README.
 */
export const RC = {
  out: resolve(CACHE_ROOT, 'receipt-capture/out'),
  state: resolve(CACHE_ROOT, 'receipt-capture/.state'),
  probeShots: resolve(CACHE_ROOT, 'receipt-capture/.probe-shots'),
  pdf: resolve(CACHE_ROOT, 'receipt-capture/out/pdf'),
  sweep: resolve(CACHE_ROOT, 'receipt-capture/out/sweep'),
  audit: resolve(CACHE_ROOT, 'receipt-capture/out/receipt-capture-audit.csv'),
} as const;

/** amazon-enrich (Engine A). Its `.receipts_cache` is shared — run-amazon.ts reads it too. */
export const AMZ = {
  out: resolve(CACHE_ROOT, 'amazon-enrich/out'),
  receipts: resolve(CACHE_ROOT, 'amazon-enrich/.receipts_cache'),
} as const;

/**
 * amazon-csv-enrich. `out/<account>/transactions.csv` is the charge-level Transactions report that
 * fetch-invoices.ts and run-attach.ts both pair from — NOT the legacy per-order charges.json.
 * Invoice PDFs are keyed by globally-unique Amazon order id, so the PDF cache is shared across
 * all three Business accounts.
 */
export const ACSV = {
  out: resolve(CACHE_ROOT, 'amazon-csv/out'),
  receipts: resolve(CACHE_ROOT, 'amazon-csv/.receipts_cache'),
  sharedPdf: resolve(CACHE_ROOT, 'amazon-csv/.receipts_cache/_shared'),
} as const;

/** walmart-enrich, covering both Walmart and Sam's Club (one sign-in serves both sites). */
export const WM = {
  out: resolve(CACHE_ROOT, 'walmart/out'),
  receipts: resolve(CACHE_ROOT, 'walmart/.receipts_cache'),
  session: resolve(CACHE_ROOT, 'walmart/.wm-session'),
} as const;

/** ramp-split-push preview output — contains cardholder PII. */
export const RSP = {
  out: resolve(CACHE_ROOT, 'ramp-split-push/out'),
} as const;

/** Playwright storageState for a receipt-capture vendor session. */
export function sessionPath(vendor: 'toprx' | 'uline', entity: Entity): string {
  return resolve(RC.state, `${vendor}-${entity}.json`);
}

/** Fetched vendor invoice PDF, named `<vendor>-<entity>-<key>.pdf`. */
export function invoicePdfPath(vendor: string, entity: Entity, key: string): string {
  return resolve(RC.pdf, `${vendor}-${entity}-${key}.pdf`);
}

/** Per-account Amazon Business Transactions report. */
export function txnReportPath(account: string): string {
  return resolve(ACSV.out, account, 'transactions.csv');
}

/** Cached Amazon invoice PDF, keyed by order id (shared across accounts). */
export function sharedPdfPath(orderId: string): string {
  return resolve(ACSV.sharedPdf, `amazon-${orderId}.pdf`);
}
