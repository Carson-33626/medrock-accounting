import { describe, it, expect } from 'vitest';
import { matchEntries } from './matcher';
import type { QBEntry, RampTxn } from './types';

function qb(p: Partial<QBEntry>): QBEntry {
  return { realm: 'FL', qbEntryId: 'q1', docType: 'Purchase', orderNo: null, txnDate: '2026-03-10', totalCents: 1999, vendor: 'Amazon Business', lines: [], ...p };
}
function rt(p: Partial<RampTxn>): RampTxn {
  return { id: 'r1', entity: 'FL', amountCents: 1999, date: '2026-03-10', cardId: 'c1', cardHolder: 'A', userId: null, memo: null, merchantName: 'Amazon', orderNo: null, priorLineItems: null, ...p };
}

describe('matchEntries', () => {
  it('Tier ①: matches on equal order number', () => {
    const r = matchEntries([qb({ orderNo: '111-2222222-3333333' })], [rt({ orderNo: '111-2222222-3333333', amountCents: 5 })], 3);
    expect(r.confident).toHaveLength(1);
    expect(r.confident[0].tier).toBe('order_no');
  });

  it('Tier ②: matches on exact amount + date window + card when unique', () => {
    const r = matchEntries([qb({})], [rt({ date: '2026-03-12' })], 3);
    expect(r.confident).toHaveLength(1);
    expect(r.confident[0].tier).toBe('amount_date');
  });

  it('Tier ②: two equal-amount candidates in window => ambiguous, not written', () => {
    const r = matchEntries([qb({})], [rt({ id: 'r1' }), rt({ id: 'r2' })], 3);
    expect(r.confident).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
  });

  it('no candidate => unmatched', () => {
    const r = matchEntries([qb({ totalCents: 9999 })], [rt({ amountCents: 1 })], 3);
    expect(r.unmatched).toHaveLength(1);
  });

  it('date outside window => not an amount_date match', () => {
    const r = matchEntries([qb({})], [rt({ date: '2026-04-30' })], 3);
    expect(r.confident).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });
});
