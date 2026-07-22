import { describe, it, expect } from 'vitest';
import { chargeToParsed } from './split-adapter';
import { buildSplit } from '../amazon-enrich/split';
import type { GlIndex } from '../amazon-enrich/gl-resolve';
import type { AmazonCharge } from './types';

const charge: AmazonCharge = {
  paymentRef: 'P1', orderIds: ['O1'], primaryOrderId: 'O1', accountGroup: 'MedRock Florida',
  chargeCents: 5324, payDate: '2026-07-22', cardLast4: '9985',
  items: [{ desc: 'Widget', amountCents: 2326 }, { desc: 'Gadget', amountCents: 2998 }],
  itemsTotalCents: 5324,
};

describe('chargeToParsed', () => {
  it('maps items to lines with zero order-level tax/shipping/tip', () => {
    const p = chargeToParsed(charge);
    expect(p.items).toHaveLength(2);
    expect(p.taxCents).toBe(0);
    expect(p.shippingCents).toBe(0);
    expect(p.parsedTotalCents).toBe(5324);
    expect(p.order).toBe('O1');
  });
  it('feeds buildSplit to a penny-exact reconcile', () => {
    const gl: GlIndex = { byName: new Map(), byCode: new Map(), suspenseId: 'SUS' };
    const built = buildSplit(chargeToParsed(charge), charge.chargeCents, gl);
    expect(built).not.toBeNull();
    const sum = built!.lines.reduce((a, b) => a + b.amount, 0);
    expect(sum).toBe(5324);
  });
  it('surfaces a partial-fulfillment mismatch for the caller to defer', () => {
    // On partial fulfillment the settled charge is less than the sum of item net totals. The adapter
    // faithfully carries parsedTotalCents = itemsTotalCents, so the caller (run-split) detects
    // itemsTotalCents !== txn amount and sets the charge aside. (buildSplit itself does NOT gate on this —
    // it forces the last line to the txn amount — which is exactly why the reconcile gate lives upstream.)
    const partial: AmazonCharge = { ...charge, chargeCents: 4000 };
    const parsed = chargeToParsed(partial);
    expect(parsed.parsedTotalCents).toBe(5324);
    expect(parsed.parsedTotalCents).not.toBe(partial.chargeCents);
  });
});
