import { describe, it, expect } from 'vitest';
import { WALMART, SAMS } from './retailer-profile';
import { receiptIdempotencyKey } from './ramp-receipts';
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

  describe('multi-entity pool (the 2026-07-30 fix)', () => {
    it('matches a TN charge and keeps the match on TN, so writes use TN credentials', () => {
      const r = matchOrders([order({})], [rt({ id: 'tn1', entity: 'TN' })], 3);
      expect(r.confident).toHaveLength(1);
      expect(r.confident[0].txn.entity).toBe('TN');
    });

    it('claims each order and each txn at most once across entities', () => {
      const orders = [order({ orderId: 'o1' }), order({ orderId: 'o2' })];
      const r = matchOrders(orders, [rt({ id: 'tn1', entity: 'TN' }), rt({ id: 'tx1', entity: 'TX' })], 3);
      // Both orders have the same amount+date, so each sees a two-entity candidate set: refuse both
      // rather than hand one order a txn from a company it may not belong to.
      expect(r.confident).toHaveLength(0);
      expect(r.ambiguous).toHaveLength(2);
    });

    it('refuses a same-amount order whose candidates span two entities', () => {
      const r = matchOrders([order({})], [rt({ id: 'fl1', entity: 'FL' }), rt({ id: 'tn1', entity: 'TN' })], 3);
      expect(r.confident).toHaveLength(0);
      expect(r.ambiguous).toHaveLength(1);
    });

    it('never lets an earlier claim collapse a cross-entity set into a confident wrong-entity match', () => {
      // o1 uniquely claims fl1. Without the pre-claim entity check, o2 would then see ONLY tn1 and score
      // "confident" — posting o2's itemization and receipt to the other company's books, with amounts
      // that still tie out so nothing downstream flags it.
      const orders = [order({ orderId: 'o1', date: '2025-06-11' }), order({ orderId: 'o2', date: '2025-06-12' })];
      const txns = [rt({ id: 'fl1', entity: 'FL', date: '2025-06-11' }), rt({ id: 'tn1', entity: 'TN', date: '2025-06-12' })];
      const r = matchOrders(orders, txns, 3);
      expect(r.confident.filter((c) => c.order.orderId === 'o2')).toHaveLength(0);
      expect(r.ambiguous.map((o) => o.orderId)).toContain('o2');
    });

    it('still matches cleanly when same-amount candidates all sit in one entity', () => {
      const orders = [order({ orderId: 'o1', date: '2025-06-11' }), order({ orderId: 'o2', date: '2025-06-20' })];
      const txns = [rt({ id: 'tn1', entity: 'TN', date: '2025-06-11' }), rt({ id: 'tn2', entity: 'TN', date: '2025-06-20' })];
      const r = matchOrders(orders, txns, 3);
      expect(r.confident).toHaveLength(2);
      expect(new Set(r.confident.map((c) => c.txn.id))).toEqual(new Set(['tn1', 'tn2']));
    });
  });
});

describe('retailer profiles', () => {
  it('Walmart and Sam\'s Club select disjoint merchants', () => {
    for (const name of ['Walmart', 'walmart.com', 'Walmart Pharmacy']) {
      expect(WALMART.merchantPattern.test(name), name).toBe(true);
      expect(SAMS.merchantPattern.test(name), name).toBe(false);
    }
    for (const name of ["Sam's Club", 'Sams Club', 'SAM’S CLUB', 'SAMSCLUB.COM']) {
      expect(SAMS.merchantPattern.test(name), name).toBe(true);
      expect(WALMART.merchantPattern.test(name), name).toBe(false);
    }
  });

  it('keeps each retailer\'s cache, PDFs and outputs on separate paths', () => {
    expect(WALMART.cacheFile).not.toBe(SAMS.cacheFile);
    expect(WALMART.pdfDir).not.toBe(SAMS.pdfDir);
    expect(WALMART.outDir).not.toBe(SAMS.outDir);
  });
});

describe('receiptIdempotencyKey', () => {
  it('is stable per transaction and unique across transactions sharing an order', () => {
    expect(receiptIdempotencyKey('walmart', 't1')).toBe('walmart-receipt-t1');
    expect(receiptIdempotencyKey('walmart', 't1')).toBe(receiptIdempotencyKey('walmart', 't1'));
    expect(receiptIdempotencyKey('walmart', 't1')).not.toBe(receiptIdempotencyKey('walmart', 't2'));
  });
  it('namespaces by vendor so two pipelines cannot collide on one txn', () => {
    expect(receiptIdempotencyKey('walmart', 't1')).not.toBe(receiptIdempotencyKey('sams', 't1'));
    expect(receiptIdempotencyKey('amazon-csv', 't1')).toBe('amazon-csv-receipt-t1');
  });
});
