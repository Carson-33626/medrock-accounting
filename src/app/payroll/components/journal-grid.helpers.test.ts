import { describe, it, expect } from 'vitest';
import { applyAmountEdit, sourceNamesPreview, type JournalLine, type RosterName } from './journal-grid.helpers';

const baseLine: JournalLine = {
  postingType: 'Debit',
  amount: 100,
  accountName: 'Payroll Expense -:Administrative Wages',
  departmentName: null,
  className: null,
  memo: '',
  creditBucket: null,
  origin: 'manual',
  sourceRowKeys: [],
};

describe('applyAmountEdit', () => {
  it('same-side edit only changes the amount', () => {
    expect(applyAmountEdit(baseLine, 'Debit', 250)).toEqual({ amount: 250 });
  });

  it('opposite-side edit on an editable line flips the side and moves the amount', () => {
    expect(applyAmountEdit(baseLine, 'Credit', 250)).toEqual({ postingType: 'Credit', amount: 250 });
  });

  it('flips Credit → Debit for a manual credit line', () => {
    const creditLine: JournalLine = { ...baseLine, postingType: 'Credit' };
    expect(applyAmountEdit(creditLine, 'Debit', 40)).toEqual({ postingType: 'Debit', amount: 40 });
  });

  it('generated line never flips side on an opposite-side edit', () => {
    const gen: JournalLine = { ...baseLine, origin: 'generated' };
    expect(applyAmountEdit(gen, 'Credit', 250)).toEqual({});
  });

  it('generated line still accepts a same-side amount edit', () => {
    const gen: JournalLine = { ...baseLine, origin: 'generated' };
    expect(applyAmountEdit(gen, 'Debit', 250)).toEqual({ amount: 250 });
  });

  it('a zero value is a valid same-side edit', () => {
    expect(applyAmountEdit(baseLine, 'Debit', 0)).toEqual({ amount: 0 });
  });
});

describe('sourceNamesPreview', () => {
  const roster: RosterName[] = [
    { rowKey: 'a', name: 'Bob' },
    { rowKey: 'b', name: 'Jane' },
    { rowKey: 'c', name: 'Amir' },
    { rowKey: 'd', name: 'Lee' },
  ];

  it('empty source list → empty string', () => {
    expect(sourceNamesPreview([], roster)).toBe('');
  });

  it('fewer than max resolved names → comma-joined, no overflow', () => {
    expect(sourceNamesPreview(['a', 'b'], roster)).toBe('Bob, Jane');
  });

  it('more than max resolved names → first max then +N', () => {
    expect(sourceNamesPreview(['a', 'b', 'c', 'd'], roster)).toBe('Bob, Jane +2');
  });

  it('respects a custom max', () => {
    expect(sourceNamesPreview(['a', 'b', 'c'], roster, 1)).toBe('Bob +2');
  });

  it('keys that resolve to no name fall back to a people count', () => {
    expect(sourceNamesPreview(['x', 'y', 'z'], roster)).toBe('(3 people)');
  });
});
