// Attach a receipt PDF to a Ramp transaction (multipart POST /receipts, scope receipts:write).
// Field names follow the Ramp Developer API receipt-upload shape: transaction_id + receipt file.
import type { Entity } from '../ramp-split-push/types';

const BASE = 'https://api.ramp.com/developer/v1';

export function buildReceiptForm(pdf: Buffer, filename: string, transactionId: string): FormData {
  const form = new FormData();
  form.set('transaction_id', transactionId);
  form.set('receipt', new File([new Uint8Array(pdf)], filename, { type: 'application/pdf' }));
  return form;
}

export async function attachReceipt(
  entity: Entity,
  transactionId: string,
  pdf: Buffer,
  filename: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  void entity; // entity is encoded in the token; kept in the signature for call-site symmetry/logging
  const res = await fetch(`${BASE}/receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type; fetch sets the multipart boundary
    body: buildReceiptForm(pdf, filename, transactionId),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
