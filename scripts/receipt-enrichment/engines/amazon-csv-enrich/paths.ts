// Shared filesystem paths for the amazon-csv-enrich pipeline. Kept in its own module (no side effects)
// so importing a path helper never triggers another script's top-level main().
//
// Since the 2026-08-07 consolidation these are thin re-exports of the program-wide paths.ts — the
// cache lives at scripts/receipt-enrichment/cache/, not next to this module. The named exports stay
// so the pipeline's existing call sites keep working unchanged.
import { ACSV, sharedPdfPath as sharedPdf, txnReportPath as txnReport } from '../../paths';

// Real invoice PDFs are cached here by order id, populated by fetch-invoices.ts and read by run-split.ts
// (one file per order; an Amazon order id is globally unique, so the cache is shared across accounts).
export const SHARED_PDF_DIR = ACSV.sharedPdf;
export const sharedPdfPath = sharedPdf;

// Per-account extraction output. `<OUT_ROOT>/<account>/transactions.csv` is the Transactions report that
// both fetch-invoices.ts and run-attach.ts pair from; `_`-prefixed children are runner outputs, not accounts.
export const OUT_ROOT = ACSV.out;
export const txnReportPath = txnReport;
