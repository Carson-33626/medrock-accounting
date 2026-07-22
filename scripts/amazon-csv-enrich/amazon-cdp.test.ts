import { describe, it, expect } from 'vitest';
import { isAmazonUrl } from './amazon-cdp';

describe('isAmazonUrl', () => {
  it('matches amazon.com pages', () => {
    expect(isAmazonUrl('https://www.amazon.com/b2b/aba/reports')).toBe(true);
    expect(isAmazonUrl('https://amazon.com/')).toBe(true);
  });
  it('rejects non-amazon', () => {
    expect(isAmazonUrl('https://www.walmart.com/orders')).toBe(false);
    expect(isAmazonUrl('about:blank')).toBe(false);
  });
});
