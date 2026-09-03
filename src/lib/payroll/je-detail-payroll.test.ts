import { describe, it, expect } from 'vitest';
import { buildPayrollJeDetailSheets } from './je-detail-payroll';
import type { LineSourceDetail } from './build-je';
import type { CellValue } from '@/lib/inventory-export';
import type { JournalLine } from './types';

function line(overrides: Partial<JournalLine>): JournalLine {
  return {
    postingType: 'Debit',
    amount: 100,
    accountName: '6000.10 Administrative Wages',
    departmentName: 'Admin',
    className: null,
    memo: 'Administrative Wages - Admin',
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: ['r1'],
    ...overrides,
  };
}

const sum = (rows: Record<string, CellValue>[], key: 'debit' | 'credit'): number =>
  rows
    .filter((r) => r.type !== 'TOTAL')
    .reduce((s, r) => s + (typeof r[key] === 'number' ? Math.round(r[key] * 100) : 0), 0) / 100;

const detail = (rows: Array<[string, number, number]>): LineSourceDetail[] =>
  rows.map(([column, amount, employees]) => ({ column, amount, employees }));

describe('buildPayrollJeDetailSheets', () => {
  it('splits each JE line into its ADP columns and foots to the entry', () => {
    const lines = [
      line({ postingType: 'Debit', amount: 1000, accountName: '6000.10 Administrative Wages' }),
      line({ postingType: 'Credit', amount: 1000, accountName: '2100 Net Pay Clearing', memo: 'Net Pay - Admin' }),
    ];
    const sheets = buildPayrollJeDetailSheets({
      storedLines: lines,
      rebuiltLines: lines,
      rebuiltSources: [
        detail([['REGULAR EARNINGS', 850, 7], ['OVERTIME EARNINGS', 150, 2]]),
        detail([['NET PAY', 1000, 7]]),
      ],
      memoSuffix: '',
      label: 'MedRock FL — PR 2026.07.01',
    });

    expect(sheets).toHaveLength(1);
    const rows = sheets[0].rows;
    expect(rows.filter((r) => r.type !== 'TOTAL')).toHaveLength(3);
    expect(sum(rows, 'debit')).toBe(1000);
    expect(sum(rows, 'credit')).toBe(1000);

    const total = rows[rows.length - 1];
    expect(total).toMatchObject({ type: 'TOTAL', debit: 1000, credit: 1000 });
  });

  it('never carries a name, id or per-person amount — only a headcount', () => {
    const lines = [line({ amount: 500, memo: 'MEDICAL - ER - Lab' })];
    const sheets = buildPayrollJeDetailSheets({
      storedLines: lines,
      rebuiltLines: lines,
      rebuiltSources: [detail([['MEDICAL - ER', 500, 4]])],
      memoSuffix: '',
      label: 'MedRock TN — PR 2026.07.01',
    });

    const row = sheets[0].rows[0];
    expect(row.employees).toBe(4);
    expect(Object.keys(row)).not.toContain('employee');
    expect(Object.keys(row)).not.toContain('positionId');
    expect(JSON.stringify(sheets[0].rows)).not.toMatch(/position/i);
  });

  it('prorates a split piece by the same ratio as the line, to the cent', () => {
    // The whole run's line is 1,000.00; this piece carries 333.33 of it. The columns behind
    // it have to come to 333.33 too, not 333.34 or 333.32.
    const stored = [line({ amount: 333.33, memo: 'Administrative Wages - Admin - Jun portion' })];
    const rebuilt = [line({ amount: 1000 })];

    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: rebuilt,
      rebuiltSources: [detail([['REGULAR EARNINGS', 666.67, 5], ['BONUS', 333.33, 1]])],
      memoSuffix: ' - Jun portion',
      label: 'MedRock FL — PR 2026.07.01A',
    });

    expect(sheets).toHaveLength(1);
    expect(sum(sheets[0].rows, 'debit')).toBe(333.33);
    expect(sheets[0].note).toContain('prorated');
  });

  it('marks hand-entered lines as having no ADP source, and still foots', () => {
    const stored = [
      line({ amount: 700 }),
      line({ postingType: 'Credit', amount: 700, accountName: '2100 Net Pay Clearing', memo: 'Net Pay', origin: 'manual', sourceRowKeys: [] }),
    ];
    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: [stored[0]],
      rebuiltSources: [detail([['REGULAR EARNINGS', 700, 3]])],
      memoSuffix: '',
      label: 'MedRock TX — PR 2026.07.01',
    });

    const manual = sheets[0].rows.find((r) => r.credit === 700);
    expect(manual?.adpColumn).toBe('(hand-entered — no ADP source)');
    expect(manual?.employees).toBeNull();
    expect(sum(sheets[0].rows, 'debit')).toBe(700);
    expect(sum(sheets[0].rows, 'credit')).toBe(700);
  });

  it('ships NOTHING when a generated line has no rebuilt source behind it', () => {
    // A mapping edited since the draft was stored. An approximate detail sheet reads as
    // authoritative, so the entry goes out with its Journal Entry sheet alone.
    const stored = [line({ amount: 400, accountName: '6000.99 Some New Account' })];
    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: [line({ amount: 400, accountName: '6000.10 Administrative Wages' })],
      rebuiltSources: [detail([['REGULAR EARNINGS', 400, 3]])],
      memoSuffix: '',
      label: 'MedRock FL — PR 2026.07.01',
    });
    expect(sheets).toEqual([]);
  });

  it('still matches when only the allocation tag moved, if the match is unambiguous', () => {
    // The CS revenue-split classes (2026-08-25) re-tagged lines that are otherwise identical
    // to what posted: same account, same memo, same dollars, different class. FL's 08/14 run
    // has 19 such lines out of 100.
    const stored = [line({ amount: 900, departmentName: '% Allocation', className: 'Allocate - %' })];
    const rebuilt = [line({ amount: 900, departmentName: null, className: 'Allocate - CS' })];

    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: rebuilt,
      rebuiltSources: [detail([['REGULAR EARNINGS', 900, 6]])],
      memoSuffix: '',
      label: 'MedRock FL — PR 2026.08.14',
    });

    expect(sheets).toHaveLength(1);
    expect(sum(sheets[0].rows, 'debit')).toBe(900);
    // The DEPARTMENT/CLASS printed are the ones that actually posted, not the rebuild's.
    expect(sheets[0].rows[0]).toMatchObject({ department: '% Allocation', className: 'Allocate - %' });
  });

  it('refuses the relaxed match when it is ambiguous on either side', () => {
    // Two stored lines share account + memo + posting type, so which rebuilt group backs
    // which is unknowable. Buckets genuinely merged or split — ship nothing.
    const stored = [
      line({ amount: 300, className: 'Allocate - %' }),
      line({ amount: 200, className: 'Allocate - CS' }),
    ];
    const rebuilt = [line({ amount: 500, className: 'Allocate - Admin' })];

    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: rebuilt,
      rebuiltSources: [detail([['REGULAR EARNINGS', 500, 6]])],
      memoSuffix: '',
      label: 'MedRock TN — PR 2026.08.14',
    });
    expect(sheets).toEqual([]);
  });

  it('merges two buckets that collapse to one row without inflating the headcount', () => {
    const stored = [line({ amount: 300 }), line({ amount: 200 })];
    const sheets = buildPayrollJeDetailSheets({
      storedLines: stored,
      rebuiltLines: stored,
      rebuiltSources: [detail([['REGULAR EARNINGS', 300, 4]]), detail([['REGULAR EARNINGS', 200, 3]])],
      memoSuffix: '',
      label: 'MedRock FL — PR 2026.07.01',
    });

    const rows = sheets[0].rows.filter((r) => r.type !== 'TOTAL');
    expect(rows).toHaveLength(1);
    expect(rows[0].debit).toBe(500);
    // 4 and 3 are overlapping sets of people, not 7 distinct ones.
    expect(rows[0].employees).toBe(4);
  });
});
