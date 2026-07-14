import { describe, it, expect } from 'vitest';
import { buildReceiptForm } from './ramp-receipts';

describe('buildReceiptForm', () => {
  it('includes transaction id, user id, idempotency key, and the file part', () => {
    const form = buildReceiptForm(Buffer.from('%PDF-1.4 test'), 'invoice.pdf', 'txn-123', 'user-abc', 'walmart-receipt-999');
    expect(form.get('transaction_id')).toBe('txn-123');
    expect(form.get('user_id')).toBe('user-abc');
    expect(form.get('idempotency_key')).toBe('walmart-receipt-999');
    const file = form.get('receipt');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('invoice.pdf');
  });
});
