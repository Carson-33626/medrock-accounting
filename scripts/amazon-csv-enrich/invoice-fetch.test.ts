import { describe, it, expect } from 'vitest';
import { invoiceUrl } from './invoice-fetch';

describe('invoiceUrl', () => {
  it('builds the b2b order-summary .html url', () => {
    expect(invoiceUrl('113-4237006-7223436')).toBe(
      'https://www.amazon.com/b2b/aba/order-summary/113-4237006-7223436.html');
  });
});
