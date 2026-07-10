import { describe, it, expect } from 'vitest';
import { buildJePayload } from './qb-journal';
import type { JournalDraft } from './types';
const draft: JournalDraft = {
  entity: 'MedRock FL', payDate: '06/18/2026', payGroup: 'MRFL', periodStart: '', periodEnd: '',
  totalDebits: 1000, totalCredits: 1000, variance: 0, rowKeys: [],
  lines: [
    { postingType: 'Debit', amount: 1000, accountName: 'COGS - Lab Wages', departmentName: null, className: null, memo: 'Lab', creditBucket: null, origin: 'generated', sourceRowKeys: [] },
    { postingType: 'Credit', amount: 1000, accountName: 'Payroll Withholdings', departmentName: null, className: null, memo: 'Net', creditBucket: 'Net Pay', origin: 'generated', sourceRowKeys: [] },
  ],
};
const refs = { accounts: { 'COGS - Lab Wages': '80', 'Payroll Withholdings': '91' }, departments: {}, classes: {} };
describe('buildJePayload', () => {
  it('builds a QB JournalEntry with DocNumber PR YYYY.MM.DD and resolved account ids', () => {
    const p = buildJePayload(draft, refs);
    expect(p.DocNumber).toBe('PR 2026.06.18');
    expect(p.Line).toHaveLength(2);
    expect(p.Line[0].JournalEntryLineDetail.AccountRef.value).toBe('80');
    expect(p.Line[0].JournalEntryLineDetail.PostingType).toBe('Debit');
  });
  it('throws if an account name has no id', () => {
    expect(() => buildJePayload(draft, { accounts: {}, departments: {}, classes: {} })).toThrow(/unresolved account/i);
  });
  it('zero-pads non-padded pay dates in DocNumber and TxnDate', () => {
    const nonPadded: JournalDraft = { ...draft, payDate: '6/1/2026' };
    const p = buildJePayload(nonPadded, refs);
    expect(p.DocNumber).toBe('PR 2026.06.01');
    expect(p.TxnDate).toBe('2026-06-01');
  });
});
