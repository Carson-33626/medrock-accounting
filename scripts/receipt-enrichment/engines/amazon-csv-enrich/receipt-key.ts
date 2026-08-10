// Idempotency key for an amazon-csv receipt upload. Kept in its own side-effect-free module so a test can
// import it without triggering run-attach.ts's top-level main().
//
// Thin wrapper over the shared builder in walmart-enrich/ramp-receipts.ts (the module every receipt-
// uploading pipeline already imports `attachReceipt` from) so both vendors key receipts identically.
// Keying on the ORDER was the 2026-07-30 field failure: Amazon bills a split-shipment order as several
// charges, each pairing to its own Ramp txn, so the second txn's upload collided with the first's key and
// died DEVELOPER_7005 "Idempotency key already exists" — permanently, on every weekly sweep. The
// transaction is the receipt-bearing unit, and it is the ONLY input: `primaryOrderId` is just whichever
// Order ID appeared on the charge's first CSV row, so a re-downloaded report could reorder those rows and
// mint a fresh key for a txn that already has its receipt. The order id is already recorded as
// `invoiceKey` on every audit row, so nothing is lost.
import { receiptIdempotencyKey } from '../walmart-enrich/ramp-receipts';

export function amazonCsvReceiptKey(txnId: string): string {
  return receiptIdempotencyKey('amazon-csv', txnId);
}
