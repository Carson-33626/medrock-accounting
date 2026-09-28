import { describe, it, expect } from 'vitest';
import { isEomAllocationDoc, qbJournalToLines, selectManualEomAdjustments, type QbJournalEntry } from './eom-manual';
import { remainderLines } from './eom-correction';
import type { JournalLine } from './types';

const APR = { year: 2026, month: 4 };

const je = (Id: string, DocNumber: string, TxnDate: string, lines: Array<['Debit' | 'Credit', number, string]>): QbJournalEntry => ({
  Id, DocNumber, TxnDate,
  Line: lines.map(([PostingType, Amount, name]) => ({ Amount, JournalEntryLineDetail: { PostingType, AccountRef: { name } } })),
});

describe('isEomAllocationDoc — the month\'s % Allo family only', () => {
  it("matches Barbara's hand-keyed suffix and the app's own names", () => {
    expect(isEomAllocationDoc('% Allo 2026.04B', APR)).toBe(true);
    expect(isEomAllocationDoc('FL % Allo 2026.04', APR)).toBe(true);
    expect(isEomAllocationDoc('TX % Allo 2026.04-2', APR)).toBe(true);
  });
  it('never matches the other allocation-shaped entries', () => {
    expect(isEomAllocationDoc('FL CS Allo 2026.04', APR)).toBe(false);
    expect(isEomAllocationDoc('FL Inv Adj 2026.04', APR)).toBe(false);
    expect(isEomAllocationDoc('FL Ship Pkg Adj 26.04', APR)).toBe(false);
    expect(isEomAllocationDoc('', APR)).toBe(false);
    expect(isEomAllocationDoc(undefined, APR)).toBe(false);
  });
  it('is month-exact', () => {
    expect(isEomAllocationDoc('% Allo 2026.05B', APR)).toBe(false);
    expect(isEomAllocationDoc('% Allo 2026.4', APR)).toBe(false);
  });
});

describe('selectManualEomAdjustments', () => {
  const b = je('54056', '% Allo 2026.04B', '2026-04-30', [
    ['Debit', 20391.82, 'Accrued Payroll Liability'], ['Credit', 19599.62, 'Due from MedRock TN, LLC'], ['Credit', 792.2, 'Due From MedRock TX, LLC'],
  ]);
  it('keeps a hand-keyed family entry dated in the month', () => {
    const out = selectManualEomAdjustments([b], APR, new Set());
    expect(out.map((a) => a.qbEntryId)).toEqual(['54056']);
    expect(out[0].lines).toHaveLength(3);
  });
  it("drops the app's own entries — they are already netted from the store", () => {
    const parent = je('54054', 'FL % Allo 2026.04', '2026-04-30', [['Debit', 1, 'X'], ['Credit', 1, 'Y']]);
    expect(selectManualEomAdjustments([parent, b], APR, new Set(['54054'])).map((a) => a.qbEntryId)).toEqual(['54056']);
  });
  it('drops a family doc number dated outside the month rather than guessing', () => {
    const oct = je('21017', '% Allo 2026.04B', '2026-10-06', [['Debit', 6000, 'X'], ['Credit', 6000, 'Y']]);
    expect(selectManualEomAdjustments([oct], APR, new Set())).toEqual([]);
  });
  it('nets the hand-keyed entry out of the remainder, so a fixed month stops flagging', () => {
    // The flagged April delta was the revenue-% line on Accrued Payroll Liability; 04B reverses it.
    const flaggedDelta: JournalLine[] = qbJournalToLines(b).map((l) => ({ ...l, origin: 'inter_entity' }));
    const manual = selectManualEomAdjustments([b], APR, new Set());
    expect(remainderLines(flaggedDelta, manual.map((a) => a.lines), 'x')).toEqual([]);
  });
});

describe('qbJournalToLines', () => {
  it('keeps QuickBooks account names verbatim and skips lines without an account', () => {
    const lines = qbJournalToLines({ Id: '1', Line: [
      { Amount: 10.005, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'Payroll Expense -:Administrative Wages' }, ClassRef: { name: 'FL' } } },
      { Amount: 5, Description: 'no account' },
    ] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ postingType: 'Debit', accountName: 'Payroll Expense -:Administrative Wages', className: 'FL', origin: 'manual' });
    expect(lines[0].amount).toBe(10.01);
  });
});
