// scripts/receipt-enrichment/paths.ts
//
// Single source of truth for every cache location in the receipt-enrichment program.
//
// Before the 2026-08-07 consolidation these were ~40 string literals spread across five modules
// (`const OUT = 'scripts/receipt-capture/out'`, `SHARED_PDF_DIR`, `SESSION_DIR`, `STATE_DIR`, …),
// which is precisely why relocating the cache was expensive. Everything now derives from
// CACHE_ROOT, so moving the cache again is a one-line change.
//
// Paths are strings RELATIVE TO `web/`, matching the existing convention — every runner is
// invoked from `web/` (`npx tsx scripts/receipt-enrichment/…`) and already assumes that cwd.
// Changing to absolute paths would be a second, unrelated migration.
//
// This module performs NO filesystem access, so importing a path never triggers a side effect and
// it is trivially testable.
import type { Entity } from './engines/ramp-split-push/types';

export const PROGRAM_ROOT = 'scripts/receipt-enrichment';
export const ENGINES_ROOT = `${PROGRAM_ROOT}/engines`;
export const CACHE_ROOT = `${PROGRAM_ROOT}/cache`;

/**
 * receipt-capture: TopRx / ULINE / Letco / Medisca extraction caches, fetched invoice PDFs, the
 * shared append-only audit CSV, and the sweep orchestrator's own output.
 *
 * `state` holds Playwright storageState — LIVE authenticated vendor sessions. Never commit, never
 * copy out of the repo. See the program README.
 */
export const RC = {
  out: `${CACHE_ROOT}/receipt-capture/out`,
  state: `${CACHE_ROOT}/receipt-capture/.state`,
  probeShots: `${CACHE_ROOT}/receipt-capture/.probe-shots`,
  pdf: `${CACHE_ROOT}/receipt-capture/out/pdf`,
  sweep: `${CACHE_ROOT}/receipt-capture/out/sweep`,
  audit: `${CACHE_ROOT}/receipt-capture/out/receipt-capture-audit.csv`,
} as const;

/** amazon-enrich (Engine A). Its `.receipts_cache` is shared — run-amazon.ts reads it too. */
export const AMZ = {
  out: `${CACHE_ROOT}/amazon-enrich/out`,
  receipts: `${CACHE_ROOT}/amazon-enrich/.receipts_cache`,
} as const;

/**
 * amazon-csv-enrich. `out/<account>/transactions.csv` is the charge-level Transactions report that
 * fetch-invoices.ts and run-attach.ts both pair from — NOT the legacy per-order charges.json.
 * Invoice PDFs are keyed by globally-unique Amazon order id, so the PDF cache is shared across
 * all three Business accounts.
 */
export const ACSV = {
  out: `${CACHE_ROOT}/amazon-csv/out`,
  receipts: `${CACHE_ROOT}/amazon-csv/.receipts_cache`,
  sharedPdf: `${CACHE_ROOT}/amazon-csv/.receipts_cache/_shared`,
} as const;

/** walmart-enrich, covering both Walmart and Sam's Club (one sign-in serves both sites). */
export const WM = {
  out: `${CACHE_ROOT}/walmart/out`,
  receipts: `${CACHE_ROOT}/walmart/.receipts_cache`,
  session: `${CACHE_ROOT}/walmart/.wm-session`,
} as const;

/** ramp-split-push preview output — contains cardholder PII. */
export const RSP = {
  out: `${CACHE_ROOT}/ramp-split-push/out`,
} as const;

/** Playwright storageState for a receipt-capture vendor session. */
export function sessionPath(vendor: 'toprx' | 'uline', entity: Entity): string {
  return `${RC.state}/${vendor}-${entity}.json`;
}

/** Fetched vendor invoice PDF, named `<vendor>-<entity>-<key>.pdf`. */
export function invoicePdfPath(vendor: string, entity: Entity, key: string): string {
  return `${RC.pdf}/${vendor}-${entity}-${key}.pdf`;
}

/** Per-account Amazon Business Transactions report. */
export function txnReportPath(account: string): string {
  return `${ACSV.out}/${account}/transactions.csv`;
}

/** Cached Amazon invoice PDF, keyed by order id (shared across accounts). */
export function sharedPdfPath(orderId: string): string {
  return `${ACSV.sharedPdf}/amazon-${orderId}.pdf`;
}
