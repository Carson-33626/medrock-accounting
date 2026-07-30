// Idempotency key for an amazon-csv receipt upload. Kept in its own side-effect-free module so a test can
// import it without triggering run-attach.ts's top-level main().
//
// The key must be stable for ONE receipt — one PDF on one transaction — so a retry or a re-run dedupes
// instead of stacking duplicates (Ramp has no receipt-delete API). Keying it on the ORDER alone was the
// 2026-07-30 field failure: Amazon bills a split-shipment order as several charges, each pairing to its own
// Ramp txn, so the second txn's upload collided with the first's key and died DEVELOPER_7005 "Idempotency
// key already exists" — permanently, on every weekly sweep. The transaction is the real receipt-bearing
// unit; the order id rides along so keys stay legible in the audit trail.
export function amazonCsvReceiptKey(txnId: string, orderId: string): string {
  return `amazon-csv-receipt-${txnId}-${orderId}`;
}
