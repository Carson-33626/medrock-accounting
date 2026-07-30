// Attach a receipt PDF to a Ramp transaction (multipart POST /receipts, scope receipts:write).
// Field names follow the Ramp Developer API receipt-upload shape: transaction_id + receipt file.
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://api.ramp.com/developer/v1';

// The idempotency key for a receipt upload, for every vendor pipeline that uploads one.
//
// It keys on the TRANSACTION, never on an order or invoice id. A retailer can bill one order as several
// charges (Amazon split shipments; Walmart per-shipment orders), each pairing to its own Ramp txn — an
// order-scoped key made the second charge's upload fail 400 "Idempotency key already exists" forever,
// which is exactly what stranded two Amazon txns until 2026-07-30. One txn carries one receipt, so the
// txn id is both stable across re-runs and unique across siblings.
export function receiptIdempotencyKey(vendor: string, txnId: string): string {
  return `${vendor}-receipt-${txnId}`;
}

// Ramp's POST /receipts requires transaction_id + receipt file AND user_id (the txn's card_holder.user_id)
// + idempotency_key — omitting the last two returns 422 "Missing data for required field". The key is
// stable per receipt so retries (or a re-run) dedupe instead of creating duplicates.
export function buildReceiptForm(pdf: Buffer, filename: string, transactionId: string, userId: string, idempotencyKey: string): FormData {
  const form = new FormData();
  form.set('transaction_id', transactionId);
  form.set('user_id', userId);
  form.set('idempotency_key', idempotencyKey);
  form.set('receipt', new File([new Uint8Array(pdf)], filename, { type: 'application/pdf' }));
  return form;
}

export async function attachReceipt(
  entity: Entity,
  transactionId: string,
  pdf: Buffer,
  filename: string,
  token: string,
  userId: string,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  void entity; // entity is encoded in the token; kept in the signature for call-site symmetry/logging
  const res = await fetch(`${BASE}/receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type; fetch sets the multipart boundary
    body: buildReceiptForm(pdf, filename, transactionId, userId, idempotencyKey),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
