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
  it('routes two charges competing for one txn to ambiguous, never a greedy pick', () => {
    const r = matchCharges([charge({ paymentRef: 'P1' }), charge({ paymentRef: 'P2' })], [txn({ id: 'A' })]);
    expect(r.confident).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(2);
    expect(r.unmatched).toHaveLength(0);
  });
  it('matches two distinct charges to their two distinct txns', () => {
    const r = matchCharges(
      [charge({ paymentRef: 'P1', chargeCents: 100 }), charge({ paymentRef: 'P2', chargeCents: 200 })],
      [txn({ id: 'A', amountCents: 100 }), txn({ id: 'B', amountCents: 200 })],
    );
    expect(r.confident).toHaveLength(2);
    expect(r.ambiguous).toHaveLength(0);
  });
  it('unmatched when amount differs', () => {
    const r = matchCharges([charge({ chargeCents: 9999 })], [txn({})]);
    expect(r.unmatched).toHaveLength(1);
  });
  it('unmatched when date is outside the window', () => {
    const r = matchCharges([charge({ payDate: '2026-07-01' })], [txn({ date: '2026-07-22' })]);
    expect(r.unmatched).toHaveLength(1);
  });
  it('flags ambiguous when candidates have null last-4 (the real Ramp case) and cannot be separated', () => {
    // Ramp never populates card_last_four in practice, so both same-amount/same-date candidates carry
    // null. Narrowing cannot separate them; the charge must go to ambiguous, never a wrong confident pick
    // and never silently unmatched. Guards the `if (narrowed.length >= 1)` fallback against refactors.
    const r = matchCharges([charge({ cardLast4: '9985' })], [
      txn({ id: 'A', cardLast4: null }), txn({ id: 'B', cardLast4: null }),
    ]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.confident).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });
  it('matches at exactly the window boundary and not one day past it', () => {
    const atEdge = matchCharges([charge({ payDate: '2026-07-22' })], [txn({ id: 'A', date: '2026-07-25' })]); // 3 days
    expect(atEdge.confident).toHaveLength(1);
    const pastEdge = matchCharges([charge({ payDate: '2026-07-22' })], [txn({ id: 'B', date: '2026-07-26' })]); // 4 days
    expect(pastEdge.unmatched).toHaveLength(1);
  });
});
