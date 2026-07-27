import { describe, it, expect } from 'vitest';
import type { JournalDraft, JournalLine } from './types';
import {
  segmentsForPeriod, segmentTag, allocateCents, pieceDocNumber, pieceTxnDate, pieceLabel, splitStraddle,
} from './split';

const line = (postingType: 'Debit' | 'Credit', amount: number, over: Partial<JournalLine> = {}): JournalLine => ({
  postingType, amount, accountName: 'COGS - Payroll Expense:COGS - Lab Wages',
  departmentName: 'FL', className: null, memo: 'Lab Wages', creditBucket: null,
  origin: 'generated', sourceRowKeys: ['rk1'], ...over,
});

/** Canonical straddler: Jun 22 – Jul 5 2026, paid 07/10 → 9/14 June, 5/14 July. */
const straddler = (lines: JournalLine[]): JournalDraft => {
  const totalDebits = lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0);
  const totalCredits = lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0);
  return {
    entity: 'MedRock TN', payDate: '07/10/2026', payGroup: 'Regular',
    periodStart: '06/22/2026', periodEnd: '07/05/2026',
    lines, totalDebits: Math.round(totalDebits * 100) / 100, totalCredits: Math.round(totalCredits * 100) / 100,
    variance: 0, rowKeys: ['rk1'],
  };
};

describe('segmentsForPeriod', () => {
  it('finds both months of a straddler', () => {
    expect(segmentsForPeriod('06/22/2026', '07/05/2026')).toEqual([
      { year: 2026, month: 6 }, { year: 2026, month: 7 },
    ]);
  });
  it('single month → one segment', () => {
    expect(segmentsForPeriod('06/17/2026', '06/30/2026')).toEqual([{ year: 2026, month: 6 }]);
  });
  it('year boundary', () => {
    expect(segmentsForPeriod('12/22/2026', '01/04/2027')).toEqual([
      { year: 2026, month: 12 }, { year: 2027, month: 1 },
    ]);
  });
  it('synthetic 3-month period → three segments', () => {
    expect(segmentsForPeriod('05/25/2026', '07/05/2026')).toHaveLength(3);
  });
});

describe('allocateCents', () => {
  it('re-sums exactly and follows largest remainder', () => {
    // 100 cents at 9/14, 5/14 → raw 64.29 / 35.71 → 64 + 36
    expect(allocateCents(100, [9 / 14, 5 / 14])).toEqual([64, 36]);
  });
  it('ties break to the earliest segment', () => {
    expect(allocateCents(1, [0.5, 0.5])).toEqual([1, 0]);
  });
  it('always re-sums', () => {
    for (const cents of [1, 3, 7, 33333, 4258976]) {
      const parts = allocateCents(cents, [9 / 14, 5 / 14]);
      expect(parts[0] + parts[1]).toBe(cents);
    }
  });
});

describe('pieceDocNumber / pieceTxnDate / segmentTag / pieceLabel', () => {
  it('doc numbers: plain when unsplit, letter-suffixed in month order when split', () => {
    expect(pieceDocNumber('07/10/2026', 1, 0)).toBe('PR 2026.07.10');
    expect(pieceDocNumber('07/10/2026', 2, 0)).toBe('PR 2026.07.10A');
    expect(pieceDocNumber('07/10/2026', 2, 1)).toBe('PR 2026.07.10B');
  });
  it('txn dates: month-end for the prior month, pay date for the pay-date month', () => {
    expect(pieceTxnDate('07/10/2026', { year: 2026, month: 6 })).toBe('2026-06-30');
    expect(pieceTxnDate('07/10/2026', { year: 2026, month: 7 })).toBe('2026-07-10');
  });
  it('tags and labels', () => {
    expect(segmentTag({ year: 2026, month: 6 })).toBe('2026-06');
    expect(pieceLabel('2026-06')).toBe('Jun');
  });
});

describe('splitStraddle', () => {
  it('non-straddler passes through untouched (deep-equal, same reference contents)', () => {
    const d = { ...straddler([line('Debit', 100), line('Credit', 100)]), periodStart: '06/17/2026', periodEnd: '06/30/2026' };
    const out = splitStraddle(d);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(d); // no kind, no docNumber, no txnDate, no periodSegment added
  });

  it('splits the canonical straddler into two balanced pieces that re-sum per line', () => {
    const d = straddler([
      line('Debit', 7904.46, { memo: 'Lab Wages' }),
      line('Debit', 1650.0, { accountName: 'Payroll Expense -:Administrative Wages', memo: 'Admin Wages' }),
      line('Credit', 9554.46, { accountName: 'Payroll Clearing', memo: 'Net Pay', creditBucket: 'Net Pay' }),
    ]);
    const [jun, jul] = splitStraddle(d);

    // identity
    expect(jun.periodSegment).toBe('2026-06');
    expect(jul.periodSegment).toBe('2026-07');
    expect(jun.kind).toBe('pay_date');
    expect(jun.docNumber).toBe('PR 2026.07.10A');
    expect(jul.docNumber).toBe('PR 2026.07.10B');
    expect(jun.txnDate).toBe('2026-06-30');
    expect(jul.txnDate).toBe('2026-07-10');
    expect(jun.privateNote).toBe('Split 1/2 of PR 2026.07.10 — period 06/22/2026–07/05/2026');

    // per-line re-sum to the ORIGINAL line, to the penny
    for (let i = 0; i < d.lines.length; i++) {
      const a = jun.lines.find((l) => l.memo.startsWith(d.lines[i].memo) && l.accountName === d.lines[i].accountName);
      const b = jul.lines.find((l) => l.memo === d.lines[i].memo && l.accountName === d.lines[i].accountName);
      const sum = Math.round(((a?.amount ?? 0) + (b?.amount ?? 0)) * 100);
      expect(sum).toBe(Math.round(d.lines[i].amount * 100));
    }

    // each piece internally balanced
    expect(jun.totalDebits).toBe(jun.totalCredits);
    expect(jul.totalDebits).toBe(jul.totalCredits);
    expect(jun.variance).toBe(0);
    expect(jul.variance).toBe(0);

    // pieces re-sum to the original totals
    expect(Math.round((jun.totalDebits + jul.totalDebits) * 100)).toBe(Math.round(d.totalDebits * 100));
  });

  it('memo suffix only on non-pay-date-month pieces', () => {
    const d = straddler([line('Debit', 100, { memo: 'Admin Wages' }), line('Credit', 100, { memo: 'Net Pay' })]);
    const [jun, jul] = splitStraddle(d);
    expect(jun.lines[0].memo).toBe('Admin Wages - Jun portion');
    expect(jul.lines[0].memo).toBe('Admin Wages'); // pay-date piece untouched
  });

  it('penny torture: odd cents stay balanced via the credit-line repair', () => {
    // Two 1-cent debits both round June-heavy; naive split leaves June D=0.02 C=0.01.
    const d = straddler([
      line('Debit', 0.01, { memo: 'A' }),
      line('Debit', 0.01, { memo: 'B' }),
      line('Credit', 0.02, { memo: 'Net Pay', accountName: 'Payroll Clearing' }),
    ]);
    const pieces = splitStraddle(d);
    for (const p of pieces) {
      expect(p.totalDebits).toBe(p.totalCredits);
      expect(p.variance).toBe(0);
    }
    // and the credit line still re-sums across pieces
    const creditSum = pieces.reduce(
      (s, p) => s + (p.lines.find((l) => l.postingType === 'Credit')?.amount ?? 0), 0);
    expect(Math.round(creditSum * 100)).toBe(2);
  });

  it('drops zero-cent lines from a piece but keeps them in the other', () => {
    const d = straddler([line('Debit', 0.01, { memo: 'A' }), line('Credit', 0.01, { memo: 'Net Pay' })]);
    const pieces = splitStraddle(d);
    const withMoney = pieces.filter((p) => p.lines.length > 0);
    expect(withMoney.length).toBeGreaterThanOrEqual(1);
    for (const p of pieces) for (const l of p.lines) expect(l.amount).toBeGreaterThan(0);
  });

  it('Admin vs Accounting memo-keyed lines on one account stay distinct through the split', () => {
    const d = straddler([
      line('Debit', 50, { accountName: 'Payroll Expense -:Administrative Wages', memo: 'Admin Wages' }),
      line('Debit', 50, { accountName: 'Payroll Expense -:Administrative Wages', memo: 'Accounting Wages' }),
      line('Credit', 100, { memo: 'Net Pay' }),
    ]);
    const [jun] = splitStraddle(d);
    const memos = jun.lines.filter((l) => l.postingType === 'Debit').map((l) => l.memo).sort();
    expect(memos).toEqual(['Accounting Wages - Jun portion', 'Admin Wages - Jun portion']);
  });

  it('unbalanced straddler passes through unsplit (mid-review state)', () => {
    // Unmapped columns leave variance in pre-review draft — do not split it yet.
    const d = straddler([
      line('Debit', 100, { memo: 'Lab Wages' }),
      line('Credit', 90, { memo: 'Net Pay' }),
    ]);
    d.variance = 10; // unbalanced
    d.totalCredits = 90;
    const out = splitStraddle(d);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(d); // no kind, no docNumber, no txnDate, no periodSegment added
  });
});
