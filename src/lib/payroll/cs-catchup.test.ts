import { describe, it, expect } from 'vitest';
import { csRemainderLines, excludeCsLines } from './cs-catchup';
import type { PoolLine } from './qb-pool';
import type { JournalLine } from './types';

const pl = (over: Partial<PoolLine>): PoolLine => ({
  entity: 'MedRock FL', txnType: 'JournalEntry', txnId: '1', txnDate: '2026-04-15', docNumber: 'PR 2026.04.10B',
  accountName: 'Payroll Expense -:Customer Service Wages', className: 'Allocate - %', departmentName: '% Allocation',
  memo: null, amount: 100, rule: 'revenue', counterparty: null,
  ...over,
});

describe('excludeCsLines (the hard rule for months with posted CS Allo entries)', () => {
  it('drops ownedPayroll and DraftJE revenue lines, keeps thirds/fifty/passthrough', () => {
    const owned = pl({ ownedPayroll: true });
    const draft = pl({ txnType: 'DraftJE' });
    const admin = pl({ rule: 'thirds', className: 'Allocate - SplitX3', accountName: 'Payroll Expense -:Administrative Wages' });
    const fifty = pl({ rule: 'fifty', counterparty: 'MedRock TN' });
    const { kept, cs } = excludeCsLines([owned, draft, admin, fifty]);
    expect(cs).toEqual([owned, draft]);
    expect(kept).toEqual([admin, fifty]);
  });

  it("external QB 'PR' JE lines: CS-named accounts are CS; the accountant's other '%'-tagged accounts stay", () => {
    // Barbara tags EVERYTHING 'Allocate - %', and her recurring re-class JEs carry 'PR' docs.
    const externalCs = pl({});
    const externalAdmin = pl({ accountName: 'Payroll Expense -:Administrative Wages' });
    const reclassJe = pl({ docNumber: 'PR 2026.07.21', accountName: 'Sales & Marketing -:Trade Conferences' });
    const bill = pl({ txnType: 'Bill', docNumber: 'CD_001414668', accountName: 'Telecommunications & Data -:Phone Expense' });
    const { kept, cs } = excludeCsLines([externalCs, externalAdmin, reclassJe, bill]);
    expect(cs).toEqual([externalCs]);
    expect(kept).toEqual([externalAdmin, reclassJe, bill]);
  });
});

const jl = (postingType: 'Debit' | 'Credit', amount: number, accountName: string, memo = 'Allocation of X — revenue % split'): JournalLine => ({
  postingType, amount, accountName, departmentName: null, className: null, memo,
  creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
});

describe('csRemainderLines (delta for top-up entries)', () => {
  const target = [
    jl('Credit', 500, 'Payroll Expense -:Customer Service Wages'),
    jl('Debit', 300, 'Due from MedRock TN, LLC'),
    jl('Debit', 200, 'Due From MedRock TX, LLC'),
  ];

  it('fully covered month -> empty remainder', () => {
    expect(csRemainderLines(target, [target])).toEqual([]);
  });

  it('no posted sets -> remainder IS the target (first issue)', () => {
    const rem = csRemainderLines(target, []);
    expect(rem).toHaveLength(3);
    const cr = rem.find((l) => l.accountName.includes('Customer Service'));
    expect(cr).toMatchObject({ postingType: 'Credit', amount: 500 });
  });

  it('partial coverage -> only the delta, balanced', () => {
    const posted = [
      jl('Credit', 400, 'Payroll Expense -:Customer Service Wages'),
      jl('Debit', 250, 'Due from MedRock TN, LLC'),
      jl('Debit', 150, 'Due From MedRock TX, LLC'),
    ];
    const rem = csRemainderLines(target, [posted]);
    expect(rem.find((l) => l.accountName.includes('Customer Service'))).toMatchObject({ postingType: 'Credit', amount: 100 });
    expect(rem.find((l) => l.accountName.includes('TN'))).toMatchObject({ postingType: 'Debit', amount: 50 });
    expect(rem.find((l) => l.accountName.includes('TX'))).toMatchObject({ postingType: 'Debit', amount: 50 });
    const signed = rem.reduce((s, l) => s + (l.postingType === 'Debit' ? 1 : -1) * Math.round(l.amount * 100), 0);
    expect(signed).toBe(0);
  });

  it('over-coverage flips the posting side (share shift pulls dollars back)', () => {
    const posted = [
      jl('Credit', 500, 'Payroll Expense -:Customer Service Wages'),
      jl('Debit', 350, 'Due from MedRock TN, LLC'),
      jl('Debit', 150, 'Due From MedRock TX, LLC'),
    ];
    const rem = csRemainderLines(target, [posted]);
    // TN was over-debited by 50 -> remainder credits TN's IE account; TX under by 50 -> debit.
    expect(rem.find((l) => l.accountName.includes('TN'))).toMatchObject({ postingType: 'Credit', amount: 50 });
    expect(rem.find((l) => l.accountName.includes('TX'))).toMatchObject({ postingType: 'Debit', amount: 50 });
    expect(rem.find((l) => l.accountName.includes('Customer Service'))).toBeUndefined();
  });

  it('multiple posted sets net cumulatively', () => {
    const first = [
      jl('Credit', 300, 'Payroll Expense -:Customer Service Wages'),
      jl('Debit', 200, 'Due from MedRock TN, LLC'),
      jl('Debit', 100, 'Due From MedRock TX, LLC'),
    ];
    const second = [
      jl('Credit', 200, 'Payroll Expense -:Customer Service Wages'),
      jl('Debit', 100, 'Due from MedRock TN, LLC'),
      jl('Debit', 100, 'Due From MedRock TX, LLC'),
    ];
    expect(csRemainderLines(target, [first, second])).toEqual([]);
  });
});
