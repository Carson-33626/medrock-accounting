import { describe, it, expect } from 'vitest';
import { nextFreeDocNumber, isValidRename } from './doc-number-conflict';

describe('nextFreeDocNumber', () => {
  it('starts at -2 when no suffix is taken', () => {
    expect(nextFreeDocNumber('PR 2026.07.21', ['PR 2026.07.21'])).toBe('PR 2026.07.21-2');
  });

  it('skips suffixes already live in the company', () => {
    expect(
      nextFreeDocNumber('PR 2026.07.21', ['PR 2026.07.21', 'PR 2026.07.21-2', 'PR 2026.07.21-3']),
    ).toBe('PR 2026.07.21-4');
  });

  it('ignores unrelated DocNumbers', () => {
    expect(nextFreeDocNumber('PR 2026.07.21', ['PR 2026.07.07-2', 'EOM FL 2026.07'])).toBe('PR 2026.07.21-2');
  });

  it('works on an empty company', () => {
    expect(nextFreeDocNumber('INV FL 2026-07', [])).toBe('INV FL 2026-07-2');
  });
});

describe('isValidRename', () => {
  it('accepts a suffix of the derived number', () => {
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.21-2')).toBe(true);
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.21-17')).toBe(true);
  });

  it('rejects an arbitrary DocNumber', () => {
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.22-2')).toBe(false);
    expect(isValidRename('PR 2026.07.21', 'whatever')).toBe(false);
  });

  it('rejects the unsuffixed number and -1 and -0', () => {
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.21')).toBe(false);
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.21-1')).toBe(false);
    expect(isValidRename('PR 2026.07.21', 'PR 2026.07.21-0')).toBe(false);
  });

  it('rejects a suffix on a DIFFERENT run that happens to end in the base', () => {
    expect(isValidRename('PR 2026.07.21', 'XPR 2026.07.21-2')).toBe(false);
  });
});
