import { describe, it, expect } from 'vitest';
import { amazonCsvReceiptKey } from './receipt-key';

describe('amazonCsvReceiptKey', () => {
  it('is stable for the same transaction + order (a re-run must dedupe, not duplicate)', () => {
    expect(amazonCsvReceiptKey('txn-1', 'O-1')).toBe(amazonCsvReceiptKey('txn-1', 'O-1'));
  });

  it('differs for two transactions billing the same order (split shipments must not collide)', () => {
    // The 2026-07-30 regression: order-scoped keys made the second shipment's upload fail DEVELOPER_7005
    // forever. Two distinct Ramp txns are two distinct receipts even when they share an order id.
    expect(amazonCsvReceiptKey('txn-1', 'O-1')).not.toBe(amazonCsvReceiptKey('txn-2', 'O-1'));
  });

  it('differs for two orders on one transaction', () => {
    expect(amazonCsvReceiptKey('txn-1', 'O-1')).not.toBe(amazonCsvReceiptKey('txn-1', 'O-2'));
  });

  it('keeps both ids legible in the key for audit lookups', () => {
    expect(amazonCsvReceiptKey('txn-1', 'O-1')).toContain('txn-1');
    expect(amazonCsvReceiptKey('txn-1', 'O-1')).toContain('O-1');
  });
});
