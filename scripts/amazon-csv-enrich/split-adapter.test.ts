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
  it('returns null (defers) when items do not reconcile to the charge', () => {
    const gl: GlIndex = { byName: new Map(), byCode: new Map(), suspenseId: 'SUS' };
    const partial = { ...charge, chargeCents: 4000 }; // partial fulfillment
    expect(buildSplit(chargeToParsed(partial), partial.chargeCents, gl)).toBeNull();
  });
});
