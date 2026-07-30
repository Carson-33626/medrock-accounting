// Idempotency key for an amazon-csv receipt upload. Kept in its own side-effect-free module so a test can
// import it without triggering run-attach.ts's top-level main().
//
// The key must be stable for ONE receipt — one PDF on one transaction — so a retry or a re-run dedupes
// instead of stacking duplicates (Ramp has no receipt-delete API). Keying it on the ORDER was the
// 2026-07-30 field failure: Amazon bills a split-shipment order as several charges, each pairing to its own
// Ramp txn, so the second txn's upload collided with the first's key and died DEVELOPER_7005 "Idempotency
// key already exists" — permanently, on every weekly sweep.
//
// The transaction alone is the key, deliberately: run-attach attaches exactly one PDF per txn, and any
// order-derived component would make the key unstable. `primaryOrderId` is just whichever Order ID appeared
// on the charge's first CSV row, and a charge can span several orders — a re-downloaded Transactions report
// may order those rows differently, which would silently mint a NEW key for a txn that already has its
// receipt. The order id is already recorded as `invoiceKey` on every audit row, so nothing is lost.
export function amazonCsvReceiptKey(txnId: string): string {
  return `amazon-csv-receipt-${txnId}`;
}
