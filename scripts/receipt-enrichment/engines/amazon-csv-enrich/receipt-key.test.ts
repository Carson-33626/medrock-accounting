import { describe, it, expect } from 'vitest';
import { amazonCsvReceiptKey } from './receipt-key';

describe('amazonCsvReceiptKey', () => {
  it('is stable for the same transaction (a re-run must dedupe, not duplicate)', () => {
    expect(amazonCsvReceiptKey('txn-1')).toBe(amazonCsvReceiptKey('txn-1'));
  });

  it('differs for two transactions billing the same order (split shipments must not collide)', () => {
    // The 2026-07-30 regression: order-scoped keys made the second shipment's upload fail DEVELOPER_7005
    // forever. Two distinct Ramp txns are two distinct receipts even when they share an order id.
    expect(amazonCsvReceiptKey('txn-1')).not.toBe(amazonCsvReceiptKey('txn-2'));
  });

  it('depends on nothing but the txn id, so a re-extract cannot mint a new key for an attached txn', () => {
    // Guards the deliberate omission of the order id: `primaryOrderId` is row-order-dependent for a
    // multi-order charge, so folding it in would make the key unstable across report re-downloads.
    expect(amazonCsvReceiptKey('txn-1')).toBe('amazon-csv-receipt-txn-1');
  });
});
