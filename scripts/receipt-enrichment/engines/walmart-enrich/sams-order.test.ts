import { describe, it, expect } from 'vitest';
import { parseSamsOrder, parseSamsRoster, type RawSamsOrder } from './sams-order';

// Both fixtures are trimmed from REAL getOrder payloads captured 2026-07-30.
// online: 10443610241 — grandTotal === grandTotalWithTips (247.86)
// in-club: 800000053836344 — grandTotal 128.50 but the card was billed 139.29 (tip excluded from
// grandTotal), which is why the parser must read grandTotalWithTips.
const online: RawSamsOrder = {
  id: '10443610241',
  orderDate: '2026-07-27T10:16:44-04:00',
  itemCount: 9,
  priceDetails: {
    taxTotal: { value: 0 },
    driverTip: { value: 13.19 },
    grandTotal: { value: 247.86 },
    grandTotalWithTips: { value: 247.86 },
    fees: [{ label: 'Delivery fee', value: 0 }, { label: 'Shipping', value: 0 }],
  },
  groups_2101: [
    { items: [
      { productInfo: { name: "Member's Mark 33-Gallon Power Flex Drawstring Trash Bags 90 ct." }, priceInfo: { linePrice: { value: 20.98 } } },
      { productInfo: { name: "Member's Mark Power Flex 13-Gallon Tall Kitchen Trash Bags, 200 ct." }, priceInfo: { linePrice: { value: 18.98 } } },
    ] },
    { items: [
      { productInfo: { name: "Member's Mark Select & Tear 2-Ply Paper Towel 15 rolls" }, priceInfo: { linePrice: { value: 20.93 } } },
      { productInfo: { name: "Member's Mark Select & Tear 2-Ply Paper Towel 15 rolls" }, priceInfo: { linePrice: { value: 20.93 } } },
      { productInfo: { name: "Member's Mark Select & Tear 2-Ply Paper Towel 15 rolls" }, priceInfo: { linePrice: { value: 20.93 } } },
      { productInfo: { name: 'Member’s Mark Bath Tissue' }, priceInfo: { linePrice: { value: 14.98 } } },
      { productInfo: { name: 'Marathon Multifold Paper Towels' }, priceInfo: { linePrice: { value: 116.94 } } },
    ] },
  ],
};

const inClub: RawSamsOrder = {
  id: '800000053836344',
  orderDate: '2026-07-22T08:44:42-04:00',
  itemCount: 7,
  priceDetails: {
    taxTotal: { value: 10.64 },
    driverTip: { value: 10.79 },
    grandTotal: { value: 128.5 },
    grandTotalWithTips: { value: 139.29 },
    fees: [{ label: 'Express fee', value: 10 }],
  },
  groups_2101: [
    { items: [
      { productInfo: { name: 'Member’s Mark 6-ft. Surge Protector' }, priceInfo: { linePrice: { value: 99.9 } } },
      { productInfo: { name: "Member's Mark Purified Water 16.9 fl. oz., 40 pk." }, priceInfo: { linePrice: { value: 7.96 } } },
    ] },
  ],
};

describe('parseSamsOrder', () => {
  it('reads the online order and reconciles items + fees + tax + tip to the charge', () => {
    const p = parseSamsOrder(online)!;
    expect(p.orderId).toBe('10443610241');
    expect(p.date).toBe('2026-07-27');
    expect(p.chargeCents).toBe(24786);
    expect(p.items).toHaveLength(7);
    expect(p.taxCents).toBe(0);
    expect(p.shippingCents).toBe(0);
    expect(p.tipCents).toBe(1319);
    expect(p.parsedTotalCents).toBe(p.chargeCents);
  });

  it('bills the in-club order at grandTotalWithTips, not grandTotal', () => {
    // The whole reason this parser exists: grandTotal (128.50) is NOT what the card was charged
    // (139.29). Matching on grandTotal would miss every tipped order.
    const p = parseSamsOrder(inClub)!;
    expect(p.chargeCents).toBe(13929);
    expect(p.chargeCents).not.toBe(12850);
    expect(p.shippingCents).toBe(1000);
    expect(p.taxCents).toBe(1064);
    expect(p.tipCents).toBe(1079);
    expect(p.parsedTotalCents).toBe(13929);
  });

  it('collects items across every fulfillment group, in order', () => {
    const p = parseSamsOrder(online)!;
    expect(p.items[0].amountCents).toBe(2098);
    expect(p.items[6].amountCents).toBe(11694);
    expect(p.items.reduce((s, i) => s + i.amountCents, 0)).toBe(23467);
  });

  it('finds items under any versioned groups_* key, not just groups_2101', () => {
    const renamed: RawSamsOrder = { ...inClub, groups_2101: undefined, groups_2200: inClub.groups_2101 };
    expect(parseSamsOrder(renamed)!.items).toHaveLength(2);
  });

  it('falls back to grandTotal only when grandTotalWithTips is absent', () => {
    const noTips: RawSamsOrder = { ...inClub, priceDetails: { ...inClub.priceDetails, grandTotalWithTips: null } };
    expect(parseSamsOrder(noTips)!.chargeCents).toBe(12850);
  });

  it('skips items with no name or no line price rather than inventing a zero line', () => {
    const messy: RawSamsOrder = { ...inClub, groups_2101: [{ items: [
      { productInfo: { name: 'Real Item' }, priceInfo: { linePrice: { value: 5 } } },
      { productInfo: { name: null }, priceInfo: { linePrice: { value: 9 } } },
      { productInfo: { name: 'No price' }, priceInfo: null },
    ] }] };
    const p = parseSamsOrder(messy)!;
    expect(p.items).toHaveLength(1);
    expect(p.items[0].desc).toBe('Real Item');
  });

  it('returns null for a payload with no id or no date', () => {
    expect(parseSamsOrder(null)).toBeNull();
    expect(parseSamsOrder({ id: 'x' })).toBeNull();
    expect(parseSamsOrder({ orderDate: '2026-01-01' })).toBeNull();
  });
});

describe('parseSamsRoster', () => {
  it('dedupes fulfillment groups down to distinct order ids and returns the cursor', () => {
    // 27 groups mapped to 10 orders in the real sample — groups are shipments, not orders.
    const r = parseSamsRoster({ data: { orderHistoryV2: {
      orderGroups: [{ orderId: 'A' }, { orderId: 'A' }, { orderId: 'B' }, { orderId: null }],
      pageInfo: { nextPageCursor: 'n1783025621' },
    } } });
    expect(r.orderIds).toEqual(['A', 'B']);
    expect(r.nextCursor).toBe('n1783025621');
  });

  it('reports a null cursor at the end of history', () => {
    const r = parseSamsRoster({ data: { orderHistoryV2: { orderGroups: [{ orderId: 'A' }], pageInfo: { nextPageCursor: null } } } });
    expect(r.nextCursor).toBeNull();
  });

  it('tolerates an empty or malformed response without throwing', () => {
    expect(parseSamsRoster({}).orderIds).toEqual([]);
    expect(parseSamsRoster({ data: null }).nextCursor).toBeNull();
  });
});
