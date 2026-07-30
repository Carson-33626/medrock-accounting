import { describe, it, expect } from 'vitest';
import { decideWrites, isTxnEnriched } from './write-gate';
import type { RampTxn } from '../ramp-split-push/types';

function txn(over: Partial<RampTxn>): RampTxn {
  return {
    id: 't', entity: 'FL', amountCents: 1000, date: '2026-07-01', cardId: null, cardHolder: null,
    userId: 'u', memo: null, merchantName: 'Walmart', orderNo: null, priorLineItems: [],
    state: 'CLEARED', syncStatus: 'NOT_SYNC_READY', receiptCount: 0, ...over,
  };
}

describe('decideWrites', () => {
  it('allows both writes on an open, un-enriched, receiptless txn', () => {
    expect(decideWrites(txn({}))).toEqual({ canSplit: true, canAttach: true, blockedReason: null });
  });

  it('blocks everything on a SYNCED txn — the 2026-07-30 HTTP 403 cause', () => {
    const d = decideWrites(txn({ syncStatus: 'SYNCED' }));
    expect(d).toEqual({ canSplit: false, canAttach: false, blockedReason: 'already_synced' });
  });

  it('blocks everything on a txn that has not cleared', () => {
    expect(decideWrites(txn({ state: 'PENDING' })).blockedReason).toBe('not_cleared');
  });

  it('blocks everything when state is unknown rather than guessing it is safe', () => {
    expect(decideWrites(txn({ state: null })).blockedReason).toBe('state_unknown');
    expect(decideWrites(txn({ syncStatus: null })).blockedReason).toBe('state_unknown');
    expect(decideWrites(txn({ state: undefined, syncStatus: undefined })).blockedReason).toBe('state_unknown');
  });

  it('names an unexpected sync status instead of silently allowing it', () => {
    expect(decideWrites(txn({ syncStatus: 'SYNC_READY' })).blockedReason).toBe('sync_status_sync_ready');
  });

  it('allows the attach alone when the txn is already split', () => {
    const d = decideWrites(txn({ priorLineItems: [{ memo: 'a' }, { memo: 'b' }] }));
    expect(d).toEqual({ canSplit: false, canAttach: true, blockedReason: null });
  });

  it('allows the split alone when the txn already has a receipt', () => {
    const d = decideWrites(txn({ receiptCount: 1 }));
    expect(d).toEqual({ canSplit: true, canAttach: false, blockedReason: null });
  });

  it('never attaches when the receipt count is unknown — a duplicate receipt is permanent', () => {
    expect(decideWrites(txn({ receiptCount: undefined })).canAttach).toBe(false);
  });

  it('blocks entirely when the txn is both split and receipted', () => {
    const d = decideWrites(txn({ priorLineItems: [{ memo: 'a' }, { memo: 'b' }], receiptCount: 1 }));
    expect(d.blockedReason).toBe('already_enriched_and_receipted');
  });
});

describe('isTxnEnriched', () => {
  it('treats multi-line, and single-line-with-memo, as already enriched', () => {
    expect(isTxnEnriched([{ memo: null }, { memo: null }])).toBe(true);
    expect(isTxnEnriched([{ memo: 'product' }])).toBe(true);
  });
  it('treats an empty, memo-less, or non-array line set as not enriched', () => {
    expect(isTxnEnriched([])).toBe(false);
    expect(isTxnEnriched([{ memo: '  ' }])).toBe(false);
    expect(isTxnEnriched(null)).toBe(false);
  });
});
