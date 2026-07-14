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
  { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'COGS - Lab Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
  { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
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
  it('does not flag ADP report aggregates (hours/totals/gross/rate) as unmapped columns', () => {
    // These carry no account-map rule by design — they summarize columns already mapped.
    // They must not pollute the "new columns detected" worklist (reconcile requires zero
    // unmapped columns to be postable), while a real unmapped column IS still surfaced.
    const rows = [
      baseRow({
        sensitive: {
          'REGULAR PAY - EARNING': 1000, // mapped
          'NET PAY': 800, // mapped
          'GROSS PAY': 1000, // aggregate → ignore
          'RATE AMOUNT': 25, // reference → ignore
          'REGULAR PAY - HOURS': 40, // hours → ignore
          'TOTAL EARNINGS': 1000, // aggregate → ignore
          'FEDERAL TAX - TOTAL': 100, // subtotal → ignore
          'TOTAL TAXES - EE': 60, // aggregate → ignore
          "WORKERS' COMPENSATION INSURANCE - TOTAL": 5, // subtotal → ignore
          'COMPANY LOAN - EE - PRINCIPAL POST-TAX': 50, // genuinely unmapped → surface
        },
      }),
    ];
    const { unmappedColumns } = buildJournal(rows, accountMap, empMap);
    expect(unmappedColumns).toContain('COMPANY LOAN - EE - PRINCIPAL POST-TAX');
    for (const agg of [
      'GROSS PAY',
      'RATE AMOUNT',
      'REGULAR PAY - HOURS',
      'TOTAL EARNINGS',
      'FEDERAL TAX - TOTAL',
      'TOTAL TAXES - EE',
      "WORKERS' COMPENSATION INSURANCE - TOTAL",
    ]) {
      expect(unmappedColumns).not.toContain(agg);
    }
  });

  it('enriches unmapped columns with total dollars + contributing people (rowKey/name)', () => {
    // Two people carry the same unmapped column; the panel shows the column TOTAL and both
    // people (name + rowKey) so an accountant can jump to each one's source detail.
    const rows = [
      baseRow({
        position_id: '1001', name: 'Doe, Jane', row_key: 'k1',
        sensitive: { 'REGULAR PAY - EARNING': 1000, 'NET PAY': 800, 'COMPANY LOAN - EE - PRINCIPAL POST-TAX': 200 },
      }),
      baseRow({
        position_id: '2002', name: 'Roe, Rich', row_key: 'k2',
        sensitive: { 'REGULAR PAY - EARNING': 500, 'NET PAY': 400, 'COMPANY LOAN - EE - PRINCIPAL POST-TAX': 52 },
      }),
    ];
    const { unmappedColumns, unmappedColumnDetails } = buildJournal(rows, accountMap, empMap);
    expect(unmappedColumns).toEqual(['COMPANY LOAN - EE - PRINCIPAL POST-TAX']);
    expect(unmappedColumnDetails).toHaveLength(1);
    const d = unmappedColumnDetails[0];
    expect(d.column).toBe('COMPANY LOAN - EE - PRINCIPAL POST-TAX');
    expect(d.amount).toBe(252); // 200 + 52 — the column total across the run
    expect(d.sources).toEqual([
      { rowKey: 'k1', name: 'Doe, Jane' },
      { rowKey: 'k2', name: 'Roe, Rich' },
    ]);
    // No per-person amount leaks into the details — only the column total is surfaced.
    for (const s of d.sources) expect(s).not.toHaveProperty('amount');
  });

  it('does not surface report aggregates in unmappedColumnDetails', () => {
    const rows = [baseRow({ sensitive: { 'REGULAR PAY - EARNING': 1000, 'NET PAY': 800, 'GROSS PAY': 1000 } })];
    const { unmappedColumnDetails } = buildJournal(rows, accountMap, empMap);
    expect(unmappedColumnDetails).toHaveLength(0);
  });

  it('excludes FOCS rows from drafts', () => {
    const rows = [baseRow({ pay_group: 'FOCS' })];
    const { drafts, excluded } = buildJournal(rows, accountMap, empMap);
    expect(drafts).toHaveLength(0);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.payGroup).toBe('FOCS');
    expect(excluded[0]?.reason).toContain('FOCS');
    expect(excluded[0]?.count).toBe(1);
  });

  it('surfaces 1099 and unknown pay groups as excluded, not silently dropped', () => {
    const rows = [
      baseRow({ pay_group: '1099', position_id: '3003', row_key: '1099row' }),
      baseRow({ pay_group: 'ZZZ', position_id: '4004', row_key: 'zzzrow' }),
    ];
    const { drafts, excluded } = buildJournal(rows, accountMap, empMap);
    expect(drafts).toHaveLength(0);
    expect(excluded).toHaveLength(2);
    const contractor = excluded.find((e) => e.payGroup === '1099');
    const unknown = excluded.find((e) => e.payGroup === 'ZZZ');
    expect(contractor?.reason).toContain('1099');
    expect(contractor?.count).toBe(1);
    expect(unknown?.reason).toContain('unknown pay group');
    expect(unknown?.count).toBe(1);
  });

  it('resolves each row against only its own entity mapping rules (no cross-entity leakage)', () => {
    const combinedAccountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'FL Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock TN', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'LAB', accountName: 'TN Wages', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
    ];
    const combinedEmpMap: EmployeeMapRule[] = [
      { entity: 'MedRock FL', positionId: '1001', departmentName: null, className: null, cogsOverride: null, active: true },
      { entity: 'MedRock TN', positionId: '2002', departmentName: null, className: null, cogsOverride: null, active: true },
    ];
    const rows = [
      baseRow({ pay_group: 'MRFL', position_id: '1001', row_key: 'fl1', sensitive: { 'REGULAR PAY - EARNING': 1000 } }),
      baseRow({ pay_group: 'MRTN', position_id: '2002', row_key: 'tn1', sensitive: { 'REGULAR PAY - EARNING': 1000 } }),
    ];
    const { drafts } = buildJournal(rows, combinedAccountMap, combinedEmpMap);
    expect(drafts).toHaveLength(2);
    const flDraft = drafts.find((d) => d.entity === 'MedRock FL');
    const tnDraft = drafts.find((d) => d.entity === 'MedRock TN');
    expect(flDraft?.lines[0]?.accountName).toBe('FL Wages');
    expect(tnDraft?.lines[0]?.accountName).toBe('TN Wages');
  });

  it('emits both a debit line and a credit line from one employer-cost column (cost-center debit + * credit)', () => {
    const employerAccountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: 'LAB', accountName: 'COGS - Employer Payroll Taxes', postingType: 'Debit', isCogs: true, creditBucket: null, active: true },
      { entity: 'MedRock FL', adpColumn: 'SOCIAL SECURITY - ER', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Taxes', active: true },
    ];
    const rows = [baseRow({ sensitive: { 'SOCIAL SECURITY - ER': 100 } })];
    const { drafts, unmappedColumns } = buildJournal(rows, employerAccountMap, empMap);
    expect(unmappedColumns).toHaveLength(0);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.lines).toHaveLength(2);
    const debit = d.lines.find((l) => l.postingType === 'Debit');
    const credit = d.lines.find((l) => l.postingType === 'Credit');
    expect(debit).toMatchObject({ accountName: 'COGS - Employer Payroll Taxes', amount: 100 });
    expect(credit).toMatchObject({ accountName: 'Payroll Withholdings', amount: 100, creditBucket: 'Taxes' });
    expect(d.totalDebits).toBe(100);
    expect(d.totalCredits).toBe(100);
  });
});
