import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWalmartOrder, orderChargeCents, extractOrderFromNextData } from './order-json';
import type { WmOrder } from './order-json';

const HERE = dirname(fileURLToPath(import.meta.url));
const order = JSON.parse(readFileSync(resolve(HERE, 'fixtures/order-json-200014784424593.json'), 'utf8')) as WmOrder;

describe('parseWalmartOrder (real order 200014784424593)', () => {
  const r = parseWalmartOrder(order);

  it('extracts the line item with its LINE total', () => {
    expect(r).not.toBeNull();
    expect(r!.items).toHaveLength(1);
    expect(r!.items[0].amountCents).toBe(2997);
    expect(r!.items[0].desc).toContain('Rogaine');
  });
  it('reads tax; tip/shipping default to 0 when absent', () => {
    expect(r!.taxCents).toBe(277);
    expect(r!.tipCents).toBe(0);
    expect(r!.shippingCents).toBe(0);
  });
  it('reconciles Σitems+tax+tip+shipping to the grand total (penny-exact)', () => {
    expect(r!.parsedTotalCents).toBe(3274);
    expect(orderChargeCents(order)).toBe(3274);
    expect(r!.parsedTotalCents).toBe(orderChargeCents(order));
  });
  it('tags layout WMT / source walmart and carries the display order id', () => {
    expect(r!.layout).toBe('WMT');
    expect(r!.source).toBe('walmart');
    expect(r!.order).toBe('2000147-84424593');
  });
  it('returns null when there are no usable line items', () => {
    expect(parseWalmartOrder({ groups_2101: [{ items: [] }], priceDetails: {} })).toBeNull();
  });

  it('sums the fees ARRAY (delivery + below-minimum) and subtracts discounts', () => {
    const r2 = parseWalmartOrder({
      groups_2101: [{ items: [{ quantity: 2, productInfo: { name: 'Great Value Water' }, priceInfo: { linePrice: { value: 10.54 } } }] }],
      priceDetails: {
        subTotal: { value: 10.54 }, taxTotal: { value: 0 }, driverTip: { value: 0 },
        fees: [{ value: 0 }, { value: 6.99 }], // "Free delivery" $0 + "Below order minimum" $6.99
        discounts: [{ value: 1.0 }],
        grandTotalWithTips: { value: 16.53 },
      },
    });
    expect(r2).not.toBeNull();
    expect(r2!.shippingCents).toBe(699); // fees array summed, not dropped
    expect(r2!.parsedTotalCents).toBe(1653); // 1054 items + 0 tax + 699 fees + 0 tip - 100 discount
    expect(r2!.parsedTotalCents).toBe(orderChargeCents({ priceDetails: { grandTotalWithTips: { value: 16.53 } } }));
  });
});

describe('extractOrderFromNextData', () => {
  it('pulls the order object out of a __NEXT_DATA__ wrapper', () => {
    const wrapped = JSON.stringify({ props: { pageProps: { initialData: { data: { order } } } } });
    const got = extractOrderFromNextData(wrapped);
    expect(got?.id).toBe('200014784424593');
  });
  it('returns null on junk', () => {
    expect(extractOrderFromNextData('not json')).toBeNull();
    expect(extractOrderFromNextData('{}')).toBeNull();
  });
});
