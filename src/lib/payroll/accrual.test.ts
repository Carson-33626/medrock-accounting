import { describe, it, expect } from 'vitest';
import { dayRatioInMonth, buildAccrual } from './accrual';
import type { JournalDraft, JournalLine } from './types';
import type { Month } from './month';

const JUN: Month = { year: 2026, month: 6 };

function line(p: 'Debit' | 'Credit', amount: number, accountName: string, memo: string, dept: string | null = null): JournalLine {
  return { postingType: p, amount, accountName, departmentName: dept, className: null, memo, creditBucket: null, origin: 'generated', sourceRowKeys: [] };
}
function draft(over: Partial<JournalDraft>): JournalDraft {
  return {
    entity: 'MedRock TN', payDate: '07/10/2026', payGroup: 'MRTN', periodStart: '06/22/2026', periodEnd: '07/05/2026',
    lines: [], totalDebits: 0, totalCredits: 0, variance: 0, rowKeys: [], kind: 'pay_date', ...over,
  };
}

describe('dayRatioInMonth', () => {
  it('prorates a straddling period by inclusive calendar days', () => {
    // 06/22..07/05 = 14 days total; 06/22..06/30 = 9 days in June
    expect(dayRatioInMonth('06/22/2026', '07/05/2026', JUN)).toBeCloseTo(9 / 14, 10);
  });
  it('is 1 for a period wholly inside the month', () => {
    expect(dayRatioInMonth('06/17/2026', '06/30/2026', JUN)).toBe(1);
  });
  it('handles a single-day period inside the month', () => {
    expect(dayRatioInMonth('06/15/2026', '06/15/2026', JUN)).toBe(1);
  });
  it('is 0 for a period entirely outside the month', () => {
    expect(dayRatioInMonth('07/01/2026', '07/14/2026', JUN)).toBe(0);
  });
});

describe('buildAccrual', () => {
  it('returns null when no draft qualifies (pay date not after month end)', () => {
    const d = draft({ payDate: '06/26/2026', periodStart: '06/08/2026', periodEnd: '06/21/2026',
      lines: [line('Debit', 100, 'Payroll Expense -:Administrative Wages', 'Admin Wages')] });
    expect(buildAccrual([d], 'MedRock TN', JUN)).toBeNull();
  });

  it('accrues debit lines only, scaled by the day ratio, offset to Accrued Payroll Liability', () => {
    const d = draft({
      payDate: '07/10/2026', periodStart: '06/22/2026', periodEnd: '07/05/2026', // ratio 9/14
      lines: [
        line('Debit', 1400, 'Payroll Expense -:Administrative Wages', 'Admin Wages'),
        line('Debit', 700, 'COGS - Payroll Expense:COGS - Lab Wages', 'Lab Wages'),
        line('Credit', 2100, 'Payroll Liabilities:Net Pay', 'Net Pay'), // excluded
      ],
    });
    const res = buildAccrual([d], 'MedRock TN', JUN);
    expect(res).not.toBeNull();
    const { accrual, reversal } = res!;

    // debits scaled 9/14, rounded to 2dp: 1400*9/14=900.00 ; 700*9/14=450.00
    const admin = accrual.lines.find((l) => l.accountName.includes('Administrative Wages'))!;
    expect(admin).toMatchObject({ postingType: 'Debit', amount: 900 });
    expect(admin.memo).toBe('Admin Wages - Jun Accrual');
    expect(accrual.lines.some((l) => l.accountName.includes('Net Pay'))).toBe(false);

    const credit = accrual.lines.find((l) => l.accountName === 'Accrued Payroll Liability')!;
    expect(credit.postingType).toBe('Credit');
    // credit == sum of the ROUNDED debits, not the rounded sum
    const debitSum = accrual.lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0);
    expect(credit.amount).toBeCloseTo(debitSum, 10);
    expect(accrual.totalDebits).toBeCloseTo(accrual.totalCredits, 10);

    expect(accrual.docNumber).toBe('PR Accru 2026.06');
    expect(accrual.txnDate).toBe('2026-06-30');
    expect(accrual.kind).toBe('accrual');
  });

  it('reversal is an exact mirror (posting types flipped, same accounts/memos/amounts) dated the 1st', () => {
    const d = draft({ lines: [line('Debit', 1400, 'Payroll Expense -:Administrative Wages', 'Admin Wages')] });
    const { accrual, reversal } = buildAccrual([d], 'MedRock TN', JUN)!;
    expect(reversal.docNumber).toBe('PR Accru 2026.06R');
    expect(reversal.txnDate).toBe('2026-07-01');
    expect(reversal.privateNote).toBe('Reverse of JE PR Accru 2026.06');
    expect(reversal.kind).toBe('reversal');
    for (let i = 0; i < accrual.lines.length; i++) {
      const a = accrual.lines[i], r = reversal.lines[i];
      expect(r.accountName).toBe(a.accountName);
      expect(r.memo).toBe(a.memo);
      expect(r.amount).toBe(a.amount);
      expect(r.postingType).toBe(a.postingType === 'Debit' ? 'Credit' : 'Debit');
    }
  });

  it('keeps Admin and Accounting as two lines on the shared account (memo preserved)', () => {
    const d = draft({
      payDate: '07/01/2026', periodStart: '06/17/2026', periodEnd: '06/30/2026', // ratio 1
      lines: [
        line('Debit', 1000, 'Payroll Expense -:Administrative Wages', 'Admin Wages'),
        line('Debit', 500, 'Payroll Expense -:Administrative Wages', 'Accounting Wages'),
      ],
    });
    const { accrual } = buildAccrual([d], 'MedRock TN', JUN)!;
    const shared = accrual.lines.filter((l) => l.accountName === 'Payroll Expense -:Administrative Wages');
    expect(shared).toHaveLength(2);
    expect(shared.map((l) => l.memo).sort()).toEqual(['Accounting Wages - Jun Accrual', 'Admin Wages - Jun Accrual']);
  });

  it('aggregates two qualifying runs for the month into one accrual', () => {
    const d1 = draft({ payDate: '07/01/2026', periodStart: '06/17/2026', periodEnd: '06/30/2026', payGroup: 'A',
      lines: [line('Debit', 1000, 'Payroll Expense -:Administrative Wages', 'Admin Wages')] });
    const d2 = draft({ payDate: '07/10/2026', periodStart: '06/22/2026', periodEnd: '07/05/2026', payGroup: 'B',
      lines: [line('Debit', 1400, 'Payroll Expense -:Administrative Wages', 'Admin Wages')] }); // 900
    const { accrual } = buildAccrual([d1, d2], 'MedRock TN', JUN)!;
    const admin = accrual.lines.filter((l) => l.accountName === 'Payroll Expense -:Administrative Wages');
    expect(admin).toHaveLength(1);
    expect(admin[0].amount).toBe(1900); // 1000 + 900
  });
});
