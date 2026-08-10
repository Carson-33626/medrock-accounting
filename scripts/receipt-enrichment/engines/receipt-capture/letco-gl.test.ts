import { describe, it, expect } from 'vitest';
import { codeLetcoInvoice, LETCO_PRODUCT_ACCOUNT, LETCO_SHIPPING_ACCOUNT } from './letco-gl';

const parsed = {
  lines: [
    { itemNo: '697237', description: 'TrichoSol', amountCents: 500000 },
    { itemNo: '123456', description: 'Azelaic Acid', amountCents: 61000 },
  ],
  shippingCents: 500,
  totalCents: 561500,
};

describe('codeLetcoInvoice', () => {
  it('codes every product line to Compound Ingredient Inventory', () => {
    const coded = codeLetcoInvoice(parsed);
    expect(coded[0].account).toBe(LETCO_PRODUCT_ACCOUNT);
    expect(coded[1].account).toBe(LETCO_PRODUCT_ACCOUNT);
  });

  it('adds one shipping line coded to COGS shipping', () => {
    const coded = codeLetcoInvoice(parsed);
    const shipping = coded.filter((l) => l.account === LETCO_SHIPPING_ACCOUNT);
    expect(shipping).toHaveLength(1);
    expect(shipping[0].amountCents).toBe(500);
    expect(shipping[0].memo).toBe('Shipping & handling');
  });

  it('carries the product name into the line memo', () => {
    expect(codeLetcoInvoice(parsed)[0].memo).toBe('TrichoSol');
  });

  it('omits the shipping line entirely when shipping is zero', () => {
    const coded = codeLetcoInvoice({ ...parsed, shippingCents: 0, totalCents: 561000 });
    expect(coded.filter((l) => l.account === LETCO_SHIPPING_ACCOUNT)).toHaveLength(0);
    expect(coded).toHaveLength(2);
  });

  it('produces lines that sum to the invoice total', () => {
    const coded = codeLetcoInvoice(parsed);
    expect(coded.reduce((a, l) => a + l.amountCents, 0)).toBe(parsed.totalCents);
  });
});
