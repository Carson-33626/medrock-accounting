import { describe, it, expect } from 'vitest';
import { assemblePool, type JeContribution } from './je-pool';
import type { JournalLine } from '@/lib/payroll/types';

function line(postingType: 'Debit' | 'Credit', amount: number, accountName: string, memo = ''): JournalLine {
  return {
    postingType,
    amount,
    accountName,
    departmentName: null,
    className: null,
    memo,
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: [],
  };
}

function contribution(over: Partial<JeContribution> & { source: JeContribution['source'] }): JeContribution {
  return {
    label: 'test',
    lines: [],
    warnings: [],
    available: true,
    ...over,
  };
}

const FIFO = contribution({
  source: 'fifo-category',
  label: 'FIFO category adjustment',
  lines: [
    line('Debit', 74647.04, 'Inventory Asset:Compound Ingredient Inventory'),
    line('Credit', 74647.04, 'Cost of Goods Sold:Compound Ingredient'),
  ],
});

const ACCRUAL = contribution({
  source: 'lab-supplies',
  label: 'Lab supplies accrual',
  lines: [
    line('Debit', 1975.36, 'Cost of Goods Sold:Lab Supplies'),
    line('Credit', 1975.36, 'Accrued Expenses'),
  ],
});

describe('assemblePool', () => {
  it('produces one balanced entry from several contributors', () => {
    const pool = assemblePool([FIFO, ACCRUAL]);
    expect(pool.lines).toHaveLength(4);
    expect(pool.totalDebits).toBe(76622.4);
    expect(pool.totalCredits).toBe(76622.4);
    expect(pool.variance).toBe(0);
    expect(pool.postable).toBe(true);
  });

  it('keeps a subtotal per contributor — one ENTRY, not one number', () => {
    const pool = assemblePool([FIFO, ACCRUAL]);
    expect(pool.subtotals).toEqual([
      { source: 'fifo-category', label: 'FIFO category adjustment', lineCount: 2, debits: 74647.04, credits: 74647.04 },
      { source: 'lab-supplies', label: 'Lab supplies accrual', lineCount: 2, debits: 1975.36, credits: 1975.36 },
    ]);
  });

  it('does NOT net two contributors that share an account', () => {
    // Merging them would destroy exactly what the pooling is meant to preserve.
    const a = contribution({ source: 'fifo-category', lines: [line('Debit', 10, 'Cost of Goods Sold:Lab Supplies', 'from FIFO')] });
    const b = contribution({ source: 'lab-supplies', lines: [line('Debit', 5, 'Cost of Goods Sold:Lab Supplies', 'from accrual')] });
    const pool = assemblePool([a, b]);

    expect(pool.lines).toHaveLength(2);
    expect(pool.lines.map((l) => l.memo)).toEqual(['from FIFO', 'from accrual']);
    expect(pool.totalDebits).toBe(15);
  });

  it('refuses to post when a contributor is unavailable, and drops its lines', () => {
    // A partial read must never become a posted number.
    const broken = contribution({
      source: 'lab-supplies',
      available: false,
      lines: [line('Debit', 999, 'Cost of Goods Sold:Lab Supplies')],
    });
    const pool = assemblePool([FIFO, broken]);

    expect(pool.unavailable).toEqual(['lab-supplies']);
    expect(pool.postable).toBe(false);
    expect(pool.lines).toHaveLength(2);
    expect(pool.totalDebits).toBe(74647.04);
    expect(pool.subtotals[1].lineCount).toBe(0);
  });

  it('distinguishes "ran and had nothing" from "never ran"', () => {
    const nothingToAccrue = contribution({ source: 'lab-supplies', label: 'Lab supplies accrual' });
    const pool = assemblePool([FIFO, nothingToAccrue]);

    expect(pool.subtotals).toHaveLength(2);
    expect(pool.subtotals[1]).toMatchObject({ source: 'lab-supplies', lineCount: 0, debits: 0, credits: 0 });
    expect(pool.postable).toBe(true);
  });

  it('refuses to post an unbalanced entry', () => {
    const lopsided = contribution({ source: 'device-standard-cost', lines: [line('Debit', 100, 'Cost of Goods Sold:Compound Packaging')] });
    const pool = assemblePool([lopsided]);

    expect(pool.variance).toBe(100);
    expect(pool.postable).toBe(false);
  });

  it('refuses to post an entry with no lines at all', () => {
    const pool = assemblePool([contribution({ source: 'fifo-category' })]);
    expect(pool.lines).toHaveLength(0);
    expect(pool.variance).toBe(0);
    expect(pool.postable).toBe(false);
  });

  it('carries every contributor warning through', () => {
    const a = contribution({ source: 'fifo-category', warnings: ['Opening Balance has no QB account'] });
    const b = contribution({ source: 'lab-supplies', warnings: ['TX borrows a pooled curve'] });
    expect(assemblePool([a, b]).warnings).toEqual([
      'Opening Balance has no QB account',
      'TX borrows a pooled curve',
    ]);
  });

  it('sums in cents so a split contribution cannot drift a penny', () => {
    const a = contribution({ source: 'fifo-category', lines: [line('Debit', 0.1, 'A'), line('Debit', 0.2, 'A')] });
    const b = contribution({ source: 'lab-supplies', lines: [line('Credit', 0.3, 'B')] });
    const pool = assemblePool([a, b]);

    expect(pool.totalDebits).toBe(0.3);
    expect(pool.variance).toBe(0);
    expect(pool.postable).toBe(true);
  });

  it('assembles nothing from nothing', () => {
    const pool = assemblePool([]);
    expect(pool.postable).toBe(false);
    expect(pool.subtotals).toEqual([]);
  });
});
