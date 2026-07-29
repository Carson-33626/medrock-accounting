import { describe, it, expect } from 'vitest';
import {
  classifyAllocateFlag,
  poolLinesFromJournalEntry,
  poolLinesFromExpenseTxn,
  type RawJournalEntry,
  type RawExpenseTxn,
} from './qb-pool';

describe('classifyAllocateFlag', () => {
  it('maps each class literal to its rule', () => {
    expect(classifyAllocateFlag('Allocate - %', null, 'MedRock FL')).toEqual({ rule: 'revenue', counterparty: null });
    expect(classifyAllocateFlag('Allocate - SplitX3', null, 'MedRock FL')).toEqual({ rule: 'thirds', counterparty: null });
    expect(classifyAllocateFlag('Allocate - Split TN50', null, 'MedRock FL')).toEqual({ rule: 'fifty', counterparty: 'MedRock TN' });
    expect(classifyAllocateFlag('Allocate - Split FL50', null, 'MedRock TN')).toEqual({ rule: 'fifty', counterparty: 'MedRock FL' });
    expect(classifyAllocateFlag('Allocate - TX', null, 'MedRock FL')).toEqual({ rule: 'passthrough', counterparty: 'MedRock TX' });
  });
  it('dept-only flag (no class) is the revenue pool', () => {
    expect(classifyAllocateFlag(null, '% Allocation', 'MedRock TN')).toEqual({ rule: 'revenue', counterparty: null });
  });
  it('unrecognized Allocate-prefixed class -> unknown (surfaced, never silently split)', () => {
    expect(classifyAllocateFlag('Allocate - Mystery', null, 'MedRock FL')).toEqual({ rule: 'unknown', counterparty: null });
  });
  it('unflagged line -> null', () => {
    expect(classifyAllocateFlag('Taxable Purchase', 'Miami Region', 'MedRock FL')).toBeNull();
    expect(classifyAllocateFlag(null, null, 'MedRock FL')).toBeNull();
  });
  it('a self-referential 50/50 or passthrough class in its own company -> unknown', () => {
    expect(classifyAllocateFlag('Allocate - FL', null, 'MedRock FL')).toEqual({ rule: 'unknown', counterparty: null });
  });
});

describe('poolLinesFromJournalEntry', () => {
  const je: RawJournalEntry = {
    Id: '17719', DocNumber: 'PR 2026.02.27', TxnDate: '2026-02-27',
    Line: [
      { Id: '1', Amount: 7615.4, Description: 'Regular Wages',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '1', name: 'Payroll Expense -:Administrative Wages' }, DepartmentRef: { value: '9', name: '% Allocation' }, ClassRef: { value: '5', name: 'Allocate - %' } } },
      { Id: '2', Amount: 100, Description: 'refund',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '1', name: 'Payroll Expense -:Administrative Wages' }, ClassRef: { value: '5', name: 'Allocate - %' } } },
      { Id: '3', Amount: 999, Description: 'unflagged',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '2', name: 'COGS - Payroll Expense:COGS - Lab Wages' } } },
    ],
  };
  it('keeps flagged lines with signed amounts, drops unflagged', () => {
    const lines = poolLinesFromJournalEntry(je, 'MedRock TN');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ entity: 'MedRock TN', txnType: 'JournalEntry', accountName: 'Payroll Expense -:Administrative Wages', amount: 7615.4, rule: 'revenue' });
    expect(lines[1].amount).toBe(-100);
  });
});

describe('poolLinesFromExpenseTxn', () => {
  const bill: RawExpenseTxn = {
    Id: '900', DocNumber: 'B-1', TxnDate: '2026-03-05',
    DepartmentRef: { value: '9', name: '% Allocation' },
    Line: [
      { Id: '1', Amount: 60, Description: 'SaaS',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '3', name: 'General & Administrative -:Dues & Subscriptions' }, ClassRef: { value: '7', name: 'Allocate - SplitX3' } } },
      { Id: '2', Amount: 40, Description: 'item line',
        ItemBasedExpenseLineDetail: { ItemRef: { value: '11', name: 'Widget' } } },
    ],
  };
  it('header dept + line class both flag; item-based flagged lines surface as unknown', () => {
    const lines = poolLinesFromExpenseTxn(bill, 'MedRock FL', 'Bill');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ rule: 'thirds', amount: 60, accountName: 'General & Administrative -:Dues & Subscriptions' });
    // item-based line under a flagged header cannot resolve an account -> unknown, accountName '(item-based line)'
    expect(lines[1]).toMatchObject({ rule: 'unknown', amount: 40, accountName: '(item-based line)' });
  });
  it('VendorCredit lines are negative; Purchase Credit=true is negative', () => {
    const vc = poolLinesFromExpenseTxn({ ...bill, Line: [bill.Line[0]] }, 'MedRock FL', 'VendorCredit');
    expect(vc[0].amount).toBe(-60);
    const refund = poolLinesFromExpenseTxn({ ...bill, Credit: true, Line: [bill.Line[0]] }, 'MedRock FL', 'Purchase');
    expect(refund[0].amount).toBe(-60);
  });
  it('unflagged header + unflagged lines -> nothing', () => {
    const plain: RawExpenseTxn = { Id: '1', TxnDate: '2026-03-01', Line: [{ Id: '1', Amount: 5, AccountBasedExpenseLineDetail: { AccountRef: { value: '3', name: 'Office' } } }] };
    expect(poolLinesFromExpenseTxn(plain, 'MedRock FL', 'Purchase')).toHaveLength(0);
  });
});
