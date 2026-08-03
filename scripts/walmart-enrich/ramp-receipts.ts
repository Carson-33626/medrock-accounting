// Attach a receipt PDF to a Ramp transaction (multipart POST /receipts, scope receipts:write).
// Field names follow the Ramp Developer API receipt-upload shape: transaction_id + receipt file.
import type { Entity } from '../ramp-split-push/types';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';

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

// Only an ACTIVE Ramp user may be named as a receipt's uploader. Anything else — suspended,
// inactive, or a status Ramp adds later that we have not vetted — is refused. This is deliberately
// a whitelist: an unrecognised status must not gamble an idempotency key, because a failed upload
// still consumes the key and permanently strands that transaction (see the test file for the
// cdb41b2b evidence trail).
export function isUploadableUserStatus(status: string | null): boolean {
  return status === 'USER_ACTIVE';
}

// One lookup per user per process; the same cardholder owns many transactions in a run.
const userStatusCache = new Map<string, string | null>();

export async function fetchUserStatus(entity: Entity, userId: string): Promise<string | null> {
  const key = `${entity}|${userId}`;
  const hit = userStatusCache.get(key);
  if (hit !== undefined) return hit;
  let status: string | null = null;
  try {
    const token = await rampToken(entity, 'users:read');
    const res = await rampGet<{ status?: string }>(entity, `/users/${userId}`, token);
    status = res.status === 200 ? (res.body.status ?? null) : null;
  } catch {
    status = null; // unknown -> refused by isUploadableUserStatus, which is the safe direction
  }
  userStatusCache.set(key, status);
  return status;
}

/** Refusal shape returned instead of POSTing when the uploader user is not active. */
export const RECEIPT_SKIP_INACTIVE_USER = 'cardholder_not_active';

export async function attachReceipt(
  entity: Entity,
  transactionId: string,
  pdf: Buffer,
  filename: string,
  token: string,
  userId: string,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  // PRE-FLIGHT, before any network write: a non-active uploader cannot succeed, and merely trying
  // burns the idempotency key forever. Refuse without touching POST /receipts.
  const status = await fetchUserStatus(entity, userId);
  if (!isUploadableUserStatus(status)) {
    return {
      status: 0,
      body: {
        skipped: RECEIPT_SKIP_INACTIVE_USER,
        user_id: userId,
        user_status: status ?? 'unknown',
        message: `Cardholder user ${userId} is ${status ?? 'unknown'}, not USER_ACTIVE — upload refused so the idempotency key stays unburned.`,
      },
    };
  }
  const res = await fetch(`${BASE}/receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type; fetch sets the multipart boundary
    body: buildReceiptForm(pdf, filename, transactionId, userId, idempotencyKey),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
