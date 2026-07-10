import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import type { JournalDraft, PayrollRow } from './types';
const rows = [{ sensitive: { 'NET PAY': 800, 'GROSS PAY': 1000, 'TOTAL TAXES - EE': 150, 'TOTAL TAXES - ER': 50 } }] as unknown as PayrollRow[];
const balanced: JournalDraft = {
  entity: 'MedRock FL', payDate: '06/18/2026', payGroup: 'MRFL', periodStart: '', periodEnd: '',
  totalDebits: 1000, totalCredits: 1000, variance: 0, rowKeys: [],
  lines: [
    { postingType: 'Debit', amount: 1000, accountName: 'Lab Wages', departmentName: null, className: null, memo: '', creditBucket: null, origin: 'generated', sourceRowKeys: [] },
    { postingType: 'Credit', amount: 800, accountName: 'Payroll Withholdings', departmentName: null, className: null, memo: '', creditBucket: 'Net Pay', origin: 'generated', sourceRowKeys: [] },
    { postingType: 'Credit', amount: 200, accountName: 'Payroll Withholdings', departmentName: null, className: null, memo: '', creditBucket: 'Taxes', origin: 'generated', sourceRowKeys: [] },
  ],
};
describe('reconcile', () => {
  it('passes a balanced, fully-mapped draft with matching net', () => {
    const r = reconcile(balanced, rows, { unmappedColumns: [], unmappedPositions: [] });
    expect(r.balanced).toBe(true); expect(r.netOk).toBe(true); expect(r.postable).toBe(true);
  });
  it('blocks when unmapped columns exist', () => {
    const r = reconcile(balanced, rows, { unmappedColumns: ['X'], unmappedPositions: [] });
    expect(r.postable).toBe(false); expect(r.unmappedColumns).toContain('X');
  });
  it('blocks when variance is nonzero', () => {
    const r = reconcile({ ...balanced, variance: 5, totalDebits: 1055 }, rows, { unmappedColumns: [], unmappedPositions: [] });
    expect(r.balanced).toBe(false); expect(r.postable).toBe(false);
  });
});
