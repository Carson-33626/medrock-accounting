import { describe, it, expect } from 'vitest';
import { matchCharges } from './matcher';
import type { AmazonCharge } from './types';
import type { RampTxn } from '../ramp-split-push/types';

function charge(over: Partial<AmazonCharge>): AmazonCharge {
  return { paymentRef: 'P', orderIds: ['O'], primaryOrderId: 'O', accountGroup: 'g', chargeCents: 5324,
    payDate: '2026-07-22', cardLast4: '9985', items: [], itemsTotalCents: 5324, ...over };
}
function txn(over: Partial<RampTxn>): RampTxn {
  return { id: 't', entity: 'FL', amountCents: 5324, date: '2026-07-22', cardId: null, cardHolder: null,
    cardLast4: '9985', userId: 'u', memo: null, merchantName: 'Amazon', orderNo: null, priorLineItems: [{ memo: null }], ...over };
}

describe('matchCharges', () => {
  it('matches a unique amount+date within the window', () => {
    const r = matchCharges([charge({})], [txn({ id: 'A', date: '2026-07-23' })]);
    expect(r.confident).toHaveLength(1);
    expect(r.confident[0].txn.id).toBe('A');
  });
  it('disambiguates two same-amount txns by card last-4', () => {
    const r = matchCharges([charge({ cardLast4: '9985' })], [
      txn({ id: 'A', cardLast4: '0000' }), txn({ id: 'B', cardLast4: '9985' }),
    ]);
    expect(r.confident).toHaveLength(1);
    expect(r.confident[0].txn.id).toBe('B');
  });
  it('flags ambiguous when last-4 cannot separate collisions', () => {
    const r = matchCharges([charge({ cardLast4: '9985' })], [
      txn({ id: 'A', cardLast4: '9985' }), txn({ id: 'B', cardLast4: '9985' }),
    ]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.confident).toHaveLength(0);
  });
  it('does not reuse a txn across two charges', () => {
    const r = matchCharges([charge({ paymentRef: 'P1' }), charge({ paymentRef: 'P2' })], [txn({ id: 'A' })]);
    expect(r.confident).toHaveLength(1);
    expect(r.unmatched).toHaveLength(1);
  });
  it('unmatched when amount differs', () => {
    const r = matchCharges([charge({ chargeCents: 9999 })], [txn({})]);
    expect(r.unmatched).toHaveLength(1);
  });
  it('unmatched when date is outside the window', () => {
    const r = matchCharges([charge({ payDate: '2026-07-01' })], [txn({ date: '2026-07-22' })]);
    expect(r.unmatched).toHaveLength(1);
  });
});
