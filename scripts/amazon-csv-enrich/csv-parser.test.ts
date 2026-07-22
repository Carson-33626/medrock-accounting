import { describe, it, expect } from 'vitest';
import { parseCsvRows, parseAmazonCsv } from './csv-parser';

// Minimal synthetic CSV: only the columns the parser reads (order-independent), no real PII.
const HEADER = 'Order Date,Order ID,Account Group,Payment Reference ID,Payment Date,Payment Amount,Payment Instrument Type,Payment Identifier,Title,Item Net Total';
const rows = [
  HEADER,
  // order O1 / payref P1 — two items, Visa, card 9985
  '07/21/2026,O1,MedRock Florida,P1,07/22/2026,"53.24",Visa,="9985","Widget, blue","23.26"',
  '07/21/2026,O1,MedRock Florida,P1,07/22/2026,"53.24",Visa,="9985","Gadget ""XL""","29.98"',
  // order O2 / payref P2 — embedded comma in Account Group
  '07/20/2026,O2,"Medrock Pharmacy, LLC",P2,07/21/2026,"10.00",American Express,="1006","Thing","10.00"',
  // skipped: Business Credit Account
  '07/19/2026,O3,MedRock Texas,P3,07/20/2026,"5.00",Business Credit Account,N/A,"Skip me","5.00"',
  // skipped: N/A payment instrument
  '07/18/2026,O4,MedRock Texas,,N/A,N/A,N/A,N/A,"No payref","1.00"',
].join('\n');

describe('parseCsvRows', () => {
  it('is quote-aware for embedded commas and escaped quotes', () => {
    const parsed = parseCsvRows(rows);
    expect(parsed[0]['Account Group']).toBe('MedRock Florida');
    expect(parsed[0]['Title']).toBe('Widget, blue');
    expect(parsed[1]['Title']).toBe('Gadget "XL"');
    expect(parsed[2]['Account Group']).toBe('Medrock Pharmacy, LLC');
  });
});

describe('parseAmazonCsv', () => {
  const charges = parseAmazonCsv(rows);
  it('groups item rows by Payment Reference ID', () => {
    expect(charges).toHaveLength(2); // P1, P2 (P3 + no-payref skipped)
    const p1 = charges.find((c) => c.paymentRef === 'P1')!;
    expect(p1.items).toHaveLength(2);
    expect(p1.itemsTotalCents).toBe(2326 + 2998);
  });
  it('captures charge amount, date, card last-4, entity-agnostic account group', () => {
    const p1 = charges.find((c) => c.paymentRef === 'P1')!;
    expect(p1.chargeCents).toBe(5324);
    expect(p1.payDate).toBe('2026-07-22');
    expect(p1.cardLast4).toBe('9985');
    expect(p1.primaryOrderId).toBe('O1');
    expect(p1.accountGroup).toBe('MedRock Florida');
  });
  it('skips Business Credit Account and rows without a payment reference', () => {
    expect(charges.find((c) => c.paymentRef === 'P3')).toBeUndefined();
    expect(charges.every((c) => c.paymentRef !== '')).toBe(true);
  });
});
