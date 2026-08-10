import { describe, it, expect } from 'vitest';
import { dedupeVerdict } from './bill-dedupe';

const none = {
  inRegistry: false,
  qbDocNumbers: new Set<string>(),
  rampInvoiceNumbers: new Set<string>(),
  rampDraftInvoiceNumbers: new Set<string>(),
};

describe('dedupeVerdict', () => {
  it('creates when the invoice is unknown everywhere', () => {
    expect(dedupeVerdict('C335-176896', none)).toBe('create');
  });

  it('skips when our own registry already recorded it', () => {
    expect(dedupeVerdict('C335-176896', { ...none, inRegistry: true })).toBe('skip_registry');
  });

  it('skips when the accountant already keyed it into QuickBooks', () => {
    expect(dedupeVerdict('C335-176896', { ...none, qbDocNumbers: new Set(['C335-176896']) })).toBe('skip_quickbooks');
  });

  it('skips when Ramp Bill Pay already has it', () => {
    expect(dedupeVerdict('C335-176896', { ...none, rampInvoiceNumbers: new Set(['C335-176896']) })).toBe('skip_ramp');
  });

  it('matches case-insensitively — the portal mixes C335 and c335', () => {
    expect(dedupeVerdict('C335-176896', { ...none, qbDocNumbers: new Set(['c335-176896']) })).toBe('skip_quickbooks');
  });

  it('ignores surrounding whitespace on the stored key', () => {
    expect(dedupeVerdict('C335-176896', { ...none, rampInvoiceNumbers: new Set([' C335-176896 ']) })).toBe('skip_ramp');
  });

  it('checks the registry first so a crashed run cannot re-create', () => {
    const facts = { ...none, inRegistry: true, qbDocNumbers: new Set(['C335-176896']) };
    expect(dedupeVerdict('C335-176896', facts)).toBe('skip_registry');
  });

  // The 2026-08-04 live pilot duplicated a draft the bookkeeper had already entered: GET /bills
  // excludes DRAFT-status bills, so this layer is the only thing that sees her work.
  it('skips when the bookkeeper already has a DRAFT for it in Ramp', () => {
    expect(dedupeVerdict('C335-176896', { ...none, rampDraftInvoiceNumbers: new Set(['C335-176896']) })).toBe('skip_draft');
  });

  it('still reports the QuickBooks hit when an invoice is in both QB and a Ramp draft', () => {
    const facts = { ...none, qbDocNumbers: new Set(['C335-176896']), rampDraftInvoiceNumbers: new Set(['C335-176896']) };
    expect(dedupeVerdict('C335-176896', facts)).toBe('skip_quickbooks');
  });
});

describe('zero-padding — QuickBooks does not preserve it', () => {
  const empty = {
    inRegistry: false,
    qbDocNumbers: new Set<string>(),
    rampInvoiceNumbers: new Set<string>(),
    rampDraftInvoiceNumbers: new Set<string>(),
  };

  it('matches a padded portal number against an unpadded QuickBooks DocNumber', () => {
    // Medisca invoice 03865107 is stored in QB as "3865107". Missing this creates a duplicate of a
    // bill already in the books.
    expect(dedupeVerdict('03865107', { ...empty, qbDocNumbers: new Set(['3865107']) }))
      .toBe('skip_quickbooks');
  });

  it('matches in the other direction too', () => {
    expect(dedupeVerdict('3865107', { ...empty, qbDocNumbers: new Set(['03865107']) }))
      .toBe('skip_quickbooks');
  });

  it('matches a padded number against a Ramp DRAFT', () => {
    expect(dedupeVerdict('04245588', { ...empty, rampDraftInvoiceNumbers: new Set(['4245588']) }))
      .toBe('skip_draft');
  });

  it('leaves Letco-style numbers alone', () => {
    expect(dedupeVerdict('C335-176896', { ...empty, qbDocNumbers: new Set(['C335-176896']) }))
      .toBe('skip_quickbooks');
    expect(dedupeVerdict('C335-176896', empty)).toBe('create');
  });

  it('does not collapse a bare zero into an empty key', () => {
    expect(dedupeVerdict('0', { ...empty, qbDocNumbers: new Set(['0']) })).toBe('skip_quickbooks');
  });

  it('still creates when nothing matches', () => {
    expect(dedupeVerdict('04245588', { ...empty, qbDocNumbers: new Set(['4245589']) })).toBe('create');
  });
});
