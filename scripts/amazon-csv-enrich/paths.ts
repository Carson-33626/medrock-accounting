// Shared filesystem paths for the amazon-csv-enrich pipeline. Kept in its own module (no side effects)
// so importing a path helper never triggers another script's top-level main().

// Real invoice PDFs are cached here by order id, populated by fetch-invoices.ts and read by run-split.ts
// (one file per order; an Amazon order id is globally unique, so the cache is shared across accounts).
export const SHARED_PDF_DIR = 'scripts/amazon-csv-enrich/.receipts_cache/_shared';
export const sharedPdfPath = (orderId: string): string => `${SHARED_PDF_DIR}/amazon-${orderId}.pdf`;
