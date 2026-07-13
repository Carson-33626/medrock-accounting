import { describe, it, expect } from 'vitest';
import { toWalmartOrders } from './order-history';

describe('toWalmartOrders', () => {
  it('parses rows into normalized orders with cents', () => {
    const out = toWalmartOrders([
      { orderId: '200013207850010', date: 'Jun 11, 2025', total: '$245.37' },
    ]);
    expect(out).toEqual([{ orderId: '200013207850010', date: '2025-06-11', totalCents: 24537 }]);
  });
  it('drops rows missing an id or total', () => {
    expect(toWalmartOrders([{ orderId: '', date: 'Jun 11, 2025', total: '$1.00' }])).toHaveLength(0);
    expect(toWalmartOrders([{ orderId: '123', date: 'Jun 11, 2025', total: '' }])).toHaveLength(0);
  });
  it('dedupes repeated order ids', () => {
    const rows = [
      { orderId: '123', date: 'Jun 11, 2025', total: '$1.00' },
      { orderId: '123', date: 'Jun 11, 2025', total: '$1.00' },
    ];
    expect(toWalmartOrders(rows)).toHaveLength(1);
  });
});
