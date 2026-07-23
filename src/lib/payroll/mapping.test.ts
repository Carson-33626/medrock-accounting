import { describe, it, expect } from 'vitest';
import { resolveLine } from './mapping';
import type { AccountMapRule, EmployeeMapRule, PayrollRow } from './types';

const row = { position_id: '1001', home_department: 'LAB-Lab' } as unknown as PayrollRow;

describe('resolveLine', () => {
  it('resolves a wage column with a cost-center-specific rule to one target carrying the employee class overlay', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '1001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true },
    ];
    const res = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    expect('targets' in res).toBe(true);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({
      accountName: 'COGS - Payroll Expense:COGS - Lab Wages',
      className: 'Allocate - %',
      postingType: 'Debit',
    });
  });

  it('flags an unknown column as unmapped', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    expect(resolveLine(row, 'MYSTERY COLUMN', accountMap, empMap)).toEqual({ unmapped: 'column' });
  });

  it('resolves a column with both a cost-center-specific debit rule and a * credit rule into TWO targets (employer double-entry)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: 'LAB', accountName: 'COGS - Employer Payroll Taxes', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Taxes', active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    const res = resolveLine(row, 'SOCIAL SECURITY - ER', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(2);
    const debit = res.targets.find((t) => t.postingType === 'Debit');
    const credit = res.targets.find((t) => t.postingType === 'Credit');
    expect(debit).toMatchObject({ accountName: 'COGS - Employer Payroll Taxes' });
    expect(credit).toMatchObject({ accountName: 'Payroll Withholdings', creditBucket: 'Taxes' });
    expect(debit?.pooled).toBe(false);
    expect(credit?.pooled).toBe(true);
  });

  it('resolves a column with a cost-center-specific Debit rule AND a * Debit rule to ONE target (cc-specific wins, same-direction duplicate cannot double-book)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: '*', accountName: 'Payroll Expense:Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = [];
    const res = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({ accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit' });
  });

  it('still resolves a row whose position has no employee rule, with null department/class (NOT unmapped)', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const empMap: EmployeeMapRule[] = []; // no overlay for position 1001
    const res = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]).toMatchObject({ accountName: 'COGS - Lab Wages', departmentName: null, className: null });
  });
});

describe('resolveLine cost-center attribution', () => {
  const ccRow = { position_id: '1001', home_department: 'PHARM-Pharmacy' } as unknown as PayrollRow;

  it('sets costCenter to the row cost center and pooled=false for a cost-center-specific rule', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'PHARM', accountName: 'COGS - Pharmacists Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true, memo: 'Pharmacists Wages' },
    ];
    const res = resolveLine(ccRow, 'REGULAR PAY - EARNING', accountMap, []);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0].costCenter).toBe('PHARM');
    expect(res.targets[0].pooled).toBe(false);
  });

  it('sets pooled=true when the matched rule is a * rule', () => {
    const accountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const res = resolveLine(ccRow, 'NET PAY', accountMap, []);
    if (!('targets' in res)) throw new Error('expected targets');
    expect(res.targets[0].costCenter).toBe('PHARM');
    expect(res.targets[0].pooled).toBe(true);
  });
});
