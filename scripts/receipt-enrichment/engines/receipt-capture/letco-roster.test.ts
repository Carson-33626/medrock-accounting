import { describe, it, expect } from 'vitest';
import { normalizeRosterItem, shouldFetchNextPage } from './letco-roster';

// Verbatim shape returned by POST /profile/orders/?OrderType=Invoice (captured live 2026-08-04).
const RAW = {
  DocumentId: 'C335-176896',
  OrderId: 'SON174161',
  DocumentDate: '8/4/2026',
  DueDate: '9/3/2026',
  TotalAmount: '$5,164.98',
  Url: '/profile/orders/details?orderid=invoice_c335-176896&originalorderid=son174161',
};

describe('normalizeRosterItem', () => {
  it('normalises dates to ISO and money to cents', () => {
    const item = normalizeRosterItem(RAW);
    expect(item).not.toBeNull();
    expect(item!.documentId).toBe('C335-176896');
    expect(item!.orderId).toBe('SON174161');
    expect(item!.documentDate).toBe('2026-08-04');
    expect(item!.dueDate).toBe('2026-09-03');
    expect(item!.totalCents).toBe(516498);
  });

  it('rejects a row with no document id — it cannot be deduped or billed', () => {
    expect(normalizeRosterItem({ ...RAW, DocumentId: '' })).toBeNull();
  });

  it('rejects a row whose total cannot be parsed rather than billing zero', () => {
    expect(normalizeRosterItem({ ...RAW, TotalAmount: '' })).toBeNull();
  });

  it('tolerates a missing due date (caller falls back to documentDate + 30)', () => {
    const item = normalizeRosterItem({ ...RAW, DueDate: undefined });
    expect(item).not.toBeNull();
    expect(item!.dueDate).toBeNull();
  });
});

describe('shouldFetchNextPage', () => {
  it('keeps paging while fewer than TotalCount rows have been collected', () => {
    expect(shouldFetchNextPage(10, 43, 10, 1, 50)).toBe(true);
  });

  it('stops once TotalCount is reached', () => {
    expect(shouldFetchNextPage(43, 43, 3, 5, 50)).toBe(false);
  });

  it('stops on an empty page even if TotalCount claims more', () => {
    expect(shouldFetchNextPage(20, 43, 0, 2, 50)).toBe(false);
  });

  it('stops at the safety cap', () => {
    expect(shouldFetchNextPage(10, 9999, 10, 50, 50)).toBe(false);
  });
});
