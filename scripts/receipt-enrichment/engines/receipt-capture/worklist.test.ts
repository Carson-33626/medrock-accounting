import { describe, it, expect } from 'vitest';
import { isVendorMerchant, isWorklisted } from './worklist';
import type { RawWorkTxn } from './worklist';

const base: RawWorkTxn = {
  id: 't1',
  amount: 123.45,
  state: 'CLEARED',
  sync_status: 'NOT_SYNC_READY',
  user_transaction_time: '2026-05-01T12:00:00+00:00',
  merchant_name: 'ULINE',
  memo: null,
  receipts: [],
  card_holder: { first_name: 'Amy', last_name: 'Murphy', user_id: 'u-1' },
  line_items: [],
};

describe('isVendorMerchant', () => {
  it('matches ULINE case-insensitively', () => {
    expect(isVendorMerchant('uline', 'ULINE')).toBe(true);
    expect(isVendorMerchant('uline', 'Uline Ship Supplies')).toBe(true);
    expect(isVendorMerchant('uline', 'TopRx')).toBe(false);
  });
  it('matches TopRx variants', () => {
    expect(isVendorMerchant('toprx', 'TopRx')).toBe(true);
    expect(isVendorMerchant('toprx', 'TOP RX LLC')).toBe(true);
    expect(isVendorMerchant('toprx', 'ULINE')).toBe(false);
  });
});

describe('isWorklisted', () => {
  it('accepts a cleared, unsynced, receiptless txn', () => {
    expect(isWorklisted(base)).toBe(true);
  });
  it('rejects when a receipt is already attached', () => {
    expect(isWorklisted({ ...base, receipts: ['r-1'] })).toBe(false);
  });
  it('rejects synced and non-cleared txns', () => {
    expect(isWorklisted({ ...base, sync_status: 'SYNCED' })).toBe(false);
    expect(isWorklisted({ ...base, state: 'PENDING' })).toBe(false);
  });
});
