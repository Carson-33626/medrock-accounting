import { describe, it, expect } from 'vitest';
import { isScanRow, rollupByMerchant, scanCsvLine, SCAN_CSV_HEADER } from './sweep-scan';
import type { ScanRow, RawScanTxn } from './sweep-scan';

const raw: RawScanTxn = {
  id: 't1', amount: 12.34, state: 'CLEARED', sync_status: 'NOT_SYNC_READY',
  user_transaction_time: '2026-07-01T00:00:00Z', merchant_name: 'ULINE', memo: null,
  receipts: [], card_holder: { first_name: 'A', last_name: 'B' }, all_requirements_met_and_approved: false,
};

describe('isScanRow', () => {
  it('accepts cleared+unsynced+receiptless (any unsynced status)', () => {
    expect(isScanRow(raw)).toBe(true);
    expect(isScanRow({ ...raw, sync_status: 'SYNC_READY' })).toBe(true);
    expect(isScanRow({ ...raw, receipts: null })).toBe(true);
  });
  it('rejects synced, pending, and receipted txns', () => {
    expect(isScanRow({ ...raw, sync_status: 'SYNCED' })).toBe(false);
    expect(isScanRow({ ...raw, state: 'PENDING' })).toBe(false);
    expect(isScanRow({ ...raw, receipts: ['r1'] })).toBe(false);
  });
});

describe('rollupByMerchant', () => {
  it('groups and sorts by absolute cents desc', () => {
    const rows: ScanRow[] = [
      { entity: 'FL', id: 'a', date: '2026-07-01', amountCents: 100, merchant: 'X', holder: '', memo: '', syncStatus: 's', approved: false },
      { entity: 'TN', id: 'b', date: '2026-07-01', amountCents: -300, merchant: 'Y', holder: '', memo: '', syncStatus: 's', approved: false },
      { entity: 'FL', id: 'c', date: '2026-07-02', amountCents: 50, merchant: 'X', holder: '', memo: '', syncStatus: 's', approved: false },
    ];
    const r = rollupByMerchant(rows);
    expect(r[0]).toEqual({ merchant: 'Y', n: 1, cents: 300 });
    expect(r[1]).toEqual({ merchant: 'X', n: 2, cents: 150 });
  });
});

describe('scanCsvLine', () => {
  it('escapes commas/quotes and matches the header column count', () => {
    const row: ScanRow = { entity: 'FL', id: 't', date: '2026-07-01', amountCents: 1234, merchant: 'A, B "C"', holder: 'H', memo: 'm', syncStatus: 'NOT_SYNC_READY', approved: true };
    const line = scanCsvLine(row);
    expect(line.split(',').length).toBeGreaterThanOrEqual(SCAN_CSV_HEADER.split(',').length);
    expect(line).toContain('"A, B ""C"""');
    expect(line).toContain('12.34');
  });
});
