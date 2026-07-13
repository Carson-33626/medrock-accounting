import { describe, it, expect } from 'vitest';
import { buildReceiptForm } from './ramp-receipts';

describe('buildReceiptForm', () => {
  it('includes the transaction id and the file part', () => {
    const form = buildReceiptForm(Buffer.from('%PDF-1.4 test'), 'invoice.pdf', 'txn-123');
    expect(form.get('transaction_id')).toBe('txn-123');
    const file = form.get('receipt');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('invoice.pdf');
  });
});
