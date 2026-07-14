import { describe, it, expect } from 'vitest';
import { matchOrders } from './matcher';
import type { WalmartOrder } from './matcher';
import type { RampTxn } from '../ramp-split-push/types';

function order(p: Partial<WalmartOrder>): WalmartOrder {
  return { orderId: '200013207850010', date: '2025-06-11', totalCents: 24537, ...p };
}
function rt(p: Partial<RampTxn>): RampTxn {
  return { id: 'r1', entity: 'FL', amountCents: 24537, date: '2025-06-11', cardId: 'c1', cardHolder: 'A', userId: null, memo: null, merchantName: 'Walmart', orderNo: null, priorLineItems: null, ...p };
}

describe('matchOrders', () => {
  it('matches on exact total + date within window when unique', () => {
    const r = matchOrders([order({})], [rt({})], 3);
    expect(r.confident).toHaveLength(1);
    expect(r.confident[0].txn.id).toBe('r1');
  });
  it('two equal-amount Walmart charges in window => ambiguous, not matched', () => {
    const r = matchOrders([order({})], [rt({ id: 'r1' }), rt({ id: 'r2' })], 3);
    expect(r.confident).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
  });
  it('date outside window => unmatched', () => {
    const r = matchOrders([order({ date: '2025-06-11' })], [rt({ date: '2025-06-30' })], 3);
    expect(r.unmatched).toHaveLength(1);
  });
  it('no equal-amount charge => unmatched', () => {
    const r = matchOrders([order({ totalCents: 99999 })], [rt({})], 3);
    expect(r.unmatched).toHaveLength(1);
  });
});
