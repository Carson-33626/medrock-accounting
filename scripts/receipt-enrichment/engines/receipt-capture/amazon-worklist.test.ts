import { describe, it, expect } from 'vitest';
import { isAmazonFamily, isAmazonWorklisted } from './amazon-worklist';
import type { RawAmazonTxn } from './amazon-worklist';
import { isEnrichedLines } from '../amazon-enrich/client';

const base: RawAmazonTxn = {
  id: 't1', amount: 20.99, state: 'CLEARED', sync_status: 'NOT_SYNC_READY',
  user_transaction_time: '2026-03-26T12:00:00Z', merchant_name: 'Amazon',
  merchant_descriptor: 'AMAZON MKTPL*B526T4PR0', memo: null, receipts: [],
  card_holder: { first_name: 'Grant', last_name: 'Powell', user_id: 'u1' }, line_items: [{ memo: null }],
};

describe('isAmazonFamily', () => {
  it('matches the retail family', () => {
    expect(isAmazonFamily('Amazon')).toBe(true);
    expect(isAmazonFamily('Amazon Marketplace')).toBe(true);
    expect(isAmazonFamily('AMZN Mktp US')).toBe(true);
  });
  it('excludes AWS and non-Amazon', () => {
    expect(isAmazonFamily('Amazon Web Services')).toBe(false);
    expect(isAmazonFamily('AWS')).toBe(false);
    expect(isAmazonFamily('Walmart')).toBe(false);
    expect(isAmazonFamily(null)).toBe(false);
  });
});

describe('isAmazonWorklisted', () => {
  it('accepts cleared + NOT_SYNC_READY (receipt NOT required)', () => {
    expect(isAmazonWorklisted(base)).toBe(true);
    expect(isAmazonWorklisted({ ...base, receipts: null })).toBe(true);
  });
  it('rejects synced, queued, and pending txns', () => {
    expect(isAmazonWorklisted({ ...base, sync_status: 'SYNCED' })).toBe(false);
    expect(isAmazonWorklisted({ ...base, sync_status: 'SYNC_READY' })).toBe(false);
    expect(isAmazonWorklisted({ ...base, state: 'PENDING' })).toBe(false);
  });
});

describe('isEnrichedLines (exported from amazon-enrich/client)', () => {
  it('multi-line split is enriched', () => {
    expect(isEnrichedLines([{ memo: 'a' }, { memo: 'b' }])).toBe(true);
  });
  it('single line with product memo is enriched', () => {
    expect(isEnrichedLines([{ memo: 'USB cable' }])).toBe(true);
  });
  it('Ramp default single null-memo line is NOT enriched', () => {
    expect(isEnrichedLines([{ memo: null }])).toBe(false);
    expect(isEnrichedLines([])).toBe(false);
    expect(isEnrichedLines([{ memo: '   ' }])).toBe(false);
  });
});
