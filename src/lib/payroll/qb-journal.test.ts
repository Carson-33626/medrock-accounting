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

describe('buildJePayload overrides (accrual/allocation)', () => {
  const refs = {
    accounts: { 'Accrued Payroll Liability': '900', 'Payroll Expense -:Administrative Wages': '910' },
    departments: {}, classes: {},
  };
  const base = {
    entity: 'MedRock TN' as const, payDate: '06/30/2026', payGroup: '', periodStart: '06/01/2026',
    periodEnd: '06/30/2026', totalDebits: 100, totalCredits: 100, variance: 0, rowKeys: [],
  };
  it('uses the per-draft DocNumber/TxnDate/PrivateNote when present', () => {
    const draft = {
      ...base, kind: 'accrual' as const, docNumber: 'PR Accru 2026.06',
      txnDate: '2026-06-30', privateNote: 'Payroll accrual — June 2026',
      lines: [
        { postingType: 'Debit' as const, amount: 100, accountName: 'Payroll Expense -:Administrative Wages', departmentName: null, className: null, memo: 'Admin Wages - Jun Accrual', creditBucket: null, origin: 'generated' as const, sourceRowKeys: [] },
        { postingType: 'Credit' as const, amount: 100, accountName: 'Accrued Payroll Liability', departmentName: null, className: null, memo: 'Admin Wages - Jun Accrual', creditBucket: null, origin: 'generated' as const, sourceRowKeys: [] },
      ],
    };
    const p = buildJePayload(draft, refs);
    expect(p.DocNumber).toBe('PR Accru 2026.06');
    expect(p.TxnDate).toBe('2026-06-30');
    expect(p.PrivateNote).toBe('Payroll accrual — June 2026');
  });
  it('falls back to the pay-date derivation when no overrides (unchanged)', () => {
    const draft = {
      ...base, payDate: '03/27/2026', payGroup: 'MRX',
      lines: [
        { postingType: 'Debit' as const, amount: 100, accountName: 'Payroll Expense -:Administrative Wages', departmentName: null, className: null, memo: '', creditBucket: null, origin: 'generated' as const, sourceRowKeys: [] },
        { postingType: 'Credit' as const, amount: 100, accountName: 'Accrued Payroll Liability', departmentName: null, className: null, memo: '', creditBucket: null, origin: 'generated' as const, sourceRowKeys: [] },
      ],
    };
    const p = buildJePayload(draft, refs);
    expect(p.DocNumber).toBe('PR 2026.03.27');
    expect(p.TxnDate).toBe('2026-03-27');
    expect(p.PrivateNote).toBe('Auto payroll JE — MRX 03/27/2026');
  });
});
