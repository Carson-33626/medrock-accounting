import { describe, it, expect } from 'vitest';
import {
  classifyAllocateFlag,
  normalizeAccountName,
  poolLinesFromJournalEntry,
  poolLinesFromExpenseTxn,
  poolLineFromLocalDraftRow,
  type RawJournalEntry,
  type RawExpenseTxn,
  type LocalDraftLineRow,
} from './qb-pool';

describe('poolLineFromLocalDraftRow', () => {
  const base: LocalDraftLineRow = {
    header_id: '412', entity: 'MedRock FL', pay_date: '07/31/2026', txn_date: '2026-07-31',
    posting_type: 'Debit', amount: '13815.01', account_name: 'Payroll Expense -:Administrative Wages',
    department_name: '% Allocation', class_name: 'Allocate - %', memo: 'Admin Wages',
  };

  it('maps a tagged Debit draft line to a positive revenue-rule pool line', () => {
    const l = poolLineFromLocalDraftRow(base);
    expect(l).toMatchObject({
      entity: 'MedRock FL', txnType: 'DraftJE', txnId: '412', txnDate: '2026-07-31',
      accountName: 'Payroll Expense -:Administrative Wages', amount: 13815.01,
      rule: 'revenue', counterparty: null,
    });
  });

  it('maps a tagged Credit line to a negative amount', () => {
    const l = poolLineFromLocalDraftRow({ ...base, posting_type: 'Credit', amount: '100.50' });
    expect(l?.amount).toBe(-100.5);
  });

  it('returns null for an untagged line', () => {
    expect(poolLineFromLocalDraftRow({ ...base, class_name: null, department_name: null })).toBeNull();
  });

  it('classifies an Allocate - TX line as passthrough (attention, not pool)', () => {
    const l = poolLineFromLocalDraftRow({ ...base, class_name: 'Allocate - TX', department_name: 'Dallas Region' });
    expect(l).toMatchObject({ rule: 'passthrough', counterparty: 'MedRock TX' });
  });
});

describe('normalizeAccountName', () => {
  it('strips a leading dotted account-number prefix', () => {
    expect(normalizeAccountName('6820.15 Telecommunications & Data -:Phone Expense'))
      .toBe('Telecommunications & Data -:Phone Expense');
    expect(normalizeAccountName('6200.45 General & Administrative -:Dues & Subscriptions'))
      .toBe('General & Administrative -:Dues & Subscriptions');
    expect(normalizeAccountName('5000.30 Cost of Goods Sold:Order Discount'))
      .toBe('Cost of Goods Sold:Order Discount');
    expect(normalizeAccountName('6800 Sales & Marketing -:Promotions'))
      .toBe('Sales & Marketing -:Promotions');
  });
  it('leaves clean names untouched', () => {
    expect(normalizeAccountName('Payroll Expense -:Administrative Wages'))
      .toBe('Payroll Expense -:Administrative Wages');
    expect(normalizeAccountName('401K Employer Match')).toBe('401K Employer Match');
  });
});

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
  it('normalizes number-prefixed account names from transaction refs', () => {
    const numbered: RawExpenseTxn = {
      Id: '77', TxnDate: '2026-03-10', DepartmentRef: { value: '9', name: '% Allocation' },
      Line: [{ Id: '1', Amount: 12, AccountBasedExpenseLineDetail: { AccountRef: { value: '3', name: '6820.15 Telecommunications & Data -:Phone Expense' } } }],
    };
    const lines = poolLinesFromExpenseTxn(numbered, 'MedRock FL', 'Bill');
    expect(lines[0].accountName).toBe('Telecommunications & Data -:Phone Expense');
  });
  it('unflagged header + unflagged lines -> nothing', () => {
    const plain: RawExpenseTxn = { Id: '1', TxnDate: '2026-03-01', Line: [{ Id: '1', Amount: 5, AccountBasedExpenseLineDetail: { AccountRef: { value: '3', name: 'Office' } } }] };
    expect(poolLinesFromExpenseTxn(plain, 'MedRock FL', 'Purchase')).toHaveLength(0);
  });
});
