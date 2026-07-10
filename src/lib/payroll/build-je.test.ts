import { describe, it, expect } from 'vitest';
import { buildJournal } from './build-je';
import type { PayrollRow, AccountMapRule, EmployeeMapRule } from './types';

const baseRow = (over: Partial<PayrollRow>): PayrollRow => ({
  position_id: '1001', name: 'Doe, Jane', status: 'Active', worker_classification: 'W-2 General Employee',
  home_department: 'LAB-Lab', location: 'MEDFL-MedRock FL', pay_date: '06/18/2026', pay_num: '1',
  pay_frequency: 'BI-WEEKLY', pay_group: 'MRFL', pay_type: 'Regular', period_start_date: '06/01/2026',
  period_end_date: '06/14/2026', processed_as: 'Bi-Weekly Payroll', rate_type: 'Hourly', sui_sdi_tax_code: 'FL',
  row_key: '1001|06/18/2026|06/01/2026|06/14/2026|Bi-Weekly Payroll', updated_at: 'x',
  sensitive: { 'REGULAR PAY - EARNING': 1000, 'NET PAY': 800, 'MEDICARE - EE TAXABLE': 1000 }, ...over,
});
const accountMap: AccountMapRule[] = [
  { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
  { entity: 'MedRock FL', adpColumn: 'NET PAY', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
];
const empMap: EmployeeMapRule[] = [{ entity: 'MedRock FL', positionId: '1001', departmentName: null, className: null, cogsOverride: null, active: true }];

describe('buildJournal', () => {
  it('aggregates two employees into one FL draft and ignores TAXABLE bases', () => {
    const rows = [baseRow({}), baseRow({ position_id: '1001', row_key: 'k2', sensitive: { 'REGULAR PAY - EARNING': 500, 'NET PAY': 400 } })];
    const { drafts, unmappedColumns } = buildJournal(rows, accountMap, empMap);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.entity).toBe('MedRock FL');
    const wages = d.lines.find((l) => l.accountName === 'COGS - Lab Wages');
    expect(wages?.amount).toBe(1500);
    expect(d.totalDebits).toBe(1500);
    expect(d.totalCredits).toBe(1200);
    expect(unmappedColumns).not.toContain('MEDICARE - EE TAXABLE'); // taxable bases excluded
  });
  it('excludes FOCS rows from drafts', () => {
    const rows = [baseRow({ pay_group: 'FOCS' })];
    const { drafts, excludedFocsRows } = buildJournal(rows, accountMap, empMap);
    expect(drafts).toHaveLength(0);
    expect(excludedFocsRows).toBe(1);
  });
});
