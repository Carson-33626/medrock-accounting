import { describe, it, expect } from 'vitest';
import {
  remainderLines, deltaDebits, isFlagged, eomCorrectionSegment, eomCorrectionIndex,
  eomCorrectionDocNumber, eomCorrectionNote, validateSettings,
} from './eom-correction';
import type { JournalLine } from './types';

const L = (postingType: 'Debit' | 'Credit', amount: number, accountName: string, memo = 'm'): JournalLine => ({
  postingType, amount, accountName, departmentName: null, className: null, memo, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
});
const M3 = { year: 2026, month: 3 };

describe('remainderLines', () => {
  const target = [L('Debit', 100, 'Wages'), L('Credit', 100, 'Due to FL')];
  it('nothing left when posted equals target', () => {
    expect(remainderLines(target, [target], 'x')).toEqual([]);
  });
  it('full target when nothing posted', () => {
    expect(remainderLines(target, [], 'x')).toEqual(target);
  });
  it('nets across parent + posted corrections and keeps the target memo', () => {
    const parent = [L('Debit', 60, 'Wages'), L('Credit', 60, 'Due to FL')];
    const c1 = [L('Debit', 30, 'Wages'), L('Credit', 30, 'Due to FL')];
    expect(remainderLines(target, [parent, c1], 'x')).toEqual([L('Debit', 10, 'Wages'), L('Credit', 10, 'Due to FL')]);
  });
  it('flips side when posted exceeds target; uses default memo for accounts only in posted', () => {
    const posted = [L('Debit', 130, 'Wages'), L('Credit', 100, 'Due to FL'), L('Credit', 30, 'Due to TN', 'old')];
    const rem = remainderLines(target, [posted], 'Month-end allocation correction');
    expect(rem).toEqual([L('Credit', 30, 'Wages'), L('Debit', 30, 'Due to TN', 'Month-end allocation correction')]);
  });
  it('target missing entirely reverses the posted lines', () => {
    const posted = [L('Debit', 50, 'Wages'), L('Credit', 50, 'Due to FL')];
    expect(remainderLines([], [posted], 'rev')).toEqual([L('Credit', 50, 'Wages', 'rev'), L('Debit', 50, 'Due to FL', 'rev')]);
  });
  it('is cent-exact on float-unfriendly amounts', () => {
    const t = [L('Debit', 0.3, 'A'), L('Credit', 0.3, 'B')];
    const p = [L('Debit', 0.1, 'A'), L('Credit', 0.1, 'B'), L('Debit', 0.2, 'A'), L('Credit', 0.2, 'B')];
    expect(remainderLines(t, [p], 'x')).toEqual([]);
  });
});

describe('deltaDebits / isFlagged', () => {
  it('sums debit dollars to the cent', () => {
    expect(deltaDebits([L('Debit', 0.1, 'A'), L('Debit', 0.2, 'B'), L('Credit', 0.3, 'C')])).toBe(0.3);
  });
  it('flags at or above threshold, never a zero delta', () => {
    expect(isFlagged(1, 1)).toBe(true);
    expect(isFlagged(0.99, 1)).toBe(false);
    expect(isFlagged(0, 0)).toBe(false);
    expect(isFlagged(250, 250.01)).toBe(false);
  });
});

describe('correction identity', () => {
  it('segments and indices round-trip', () => {
    expect(eomCorrectionSegment(1)).toBe('C1');
    expect(eomCorrectionIndex('C12')).toBe(12);
    expect(eomCorrectionIndex('')).toBeNull();
    expect(eomCorrectionIndex('2026-03')).toBeNull();
    expect(eomCorrectionIndex('C0')).toBeNull();
  });
  it('doc number is parent doc + (index + 1)', () => {
    expect(eomCorrectionDocNumber('MedRock FL', M3, 1)).toBe('FL % Allo 2026.03-2');
    expect(eomCorrectionDocNumber('MedRock TX', M3, 2)).toBe('TX % Allo 2026.03-3');
  });
  it('note names the parent and the date found', () => {
    expect(eomCorrectionNote('MedRock TN', M3, 1, '2026-09-26')).toBe(
      'Month-end allocation correction 1 to TN % Allo 2026.03 — difference found 2026-09-26: ' +
      'late pool activity / revenue share changes since the entry posted.',
    );
  });
});

describe('validateSettings', () => {
  it('accepts a valid partial update', () => {
    expect(validateSettings({ threshold: 5, checkFromMonth: '2026-04' })).toEqual({ ok: true, value: { threshold: 5, checkFromMonth: '2026-04' } });
  });
  it('rejects negative / non-finite thresholds and bad months', () => {
    expect(validateSettings({ threshold: -1 }).ok).toBe(false);
    expect(validateSettings({ threshold: Number.NaN }).ok).toBe(false);
    expect(validateSettings({ checkFromMonth: '2026-4' }).ok).toBe(false);
  });
  it('rounds threshold to cents', () => {
    expect(validateSettings({ threshold: 1.005 })).toEqual({ ok: true, value: { threshold: 1.01 } });
  });
});
