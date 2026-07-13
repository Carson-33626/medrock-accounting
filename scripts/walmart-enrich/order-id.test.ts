import { describe, it, expect } from 'vitest';
import { normalizeOrderId, buildInvoiceUrl, buildOrderHistoryUrl } from './order-id';

describe('order-id helpers', () => {
  it('strips the dash from the email order number', () => {
    expect(normalizeOrderId('2000132-07850010')).toBe('200013207850010');
  });
  it('leaves an already-normalized id unchanged', () => {
    expect(normalizeOrderId('200013207850010')).toBe('200013207850010');
  });
  it('builds the invoice URL from either form', () => {
    expect(buildInvoiceUrl('2000132-07850010')).toBe('https://www.walmart.com/orders/200013207850010');
  });
  it('builds the order-history URL', () => {
    expect(buildOrderHistoryUrl()).toBe('https://www.walmart.com/orders');
  });
});
