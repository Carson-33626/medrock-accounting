import { describe, it, expect } from 'vitest';
import { resolveLine } from './mapping';
import type { AccountMapRule, EmployeeMapRule, PayrollRow } from './types';
const row = { position_id: '1001', home_department: 'LAB-Lab', entityHint: 'MedRock FL' } as unknown as PayrollRow;
const accountMap: AccountMapRule[] = [{ entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', accountName: 'COGS - Payroll Expense:COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true }];
const empMap: EmployeeMapRule[] = [{ entity: 'MedRock FL', positionId: '1001', departmentName: null, className: 'Allocate - %', cogsOverride: null, active: true }];
describe('resolveLine', () => {
  it('resolves account + class from the two maps', () => {
    const t = resolveLine(row, 'REGULAR PAY - EARNING', accountMap, empMap);
    expect(t).toMatchObject({ accountName: 'COGS - Payroll Expense:COGS - Lab Wages', className: 'Allocate - %', postingType: 'Debit' });
  });
  it('flags an unmapped column', () => {
    expect(resolveLine(row, 'MYSTERY COLUMN', accountMap, empMap)).toEqual({ unmapped: 'column' });
  });
  it('flags an unmapped position', () => {
    const t = resolveLine({ ...row, position_id: '9999' } as PayrollRow, 'REGULAR PAY - EARNING', accountMap, empMap);
    expect(t).toEqual({ unmapped: 'position' });
  });
});
