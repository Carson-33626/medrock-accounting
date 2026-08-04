import { describe, it, expect } from 'vitest';
import { dedupeVerdict } from './bill-dedupe';

const none = { inRegistry: false, qbDocNumbers: new Set<string>(), rampInvoiceNumbers: new Set<string>() };

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
    const facts = { inRegistry: true, qbDocNumbers: new Set(['C335-176896']), rampInvoiceNumbers: new Set<string>() };
    expect(dedupeVerdict('C335-176896', facts)).toBe('skip_registry');
  });
});
