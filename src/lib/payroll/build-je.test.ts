import { describe, it, expect } from 'vitest';
import { buildJournal, mergeRebuiltLines } from './build-je';
import type { PayrollRow, AccountMapRule, EmployeeMapRule, JournalLine } from './types';

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

  it('splits a shared account into per-department lines by memo (Admin vs Accounting wages)', () => {
    // ADMIN and ACCOUN cost-centers both post to the SAME account but carry distinct memos —
    // Barbara's ask: one readable line per department on 'Administrative Wages', not a lump.
    const memoAccountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ADMIN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'Admin Wages' },
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ACCOUN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'Accounting Wages' },
      { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true },
    ];
    const rows = [
      baseRow({ position_id: 'a1', row_key: 'admin1', home_department: 'ADMIN-Administration', sensitive: { 'REGULAR PAY - EARNING': 12957.70, 'NET PAY': 9000 } }),
      baseRow({ position_id: 'c1', row_key: 'acct1', home_department: 'ACCOUN-Accounting', sensitive: { 'REGULAR PAY - EARNING': 4645.17, 'NET PAY': 3000 } }),
    ];
    const { drafts } = buildJournal(rows, memoAccountMap, empMap);
    const wageLines = drafts[0]?.lines.filter((l) => l.accountName === 'Payroll Expense -:Administrative Wages') ?? [];
    expect(wageLines).toHaveLength(2); // one line per department memo, same account
    const admin = wageLines.find((l) => l.memo === 'Admin Wages');
    const accounting = wageLines.find((l) => l.memo === 'Accounting Wages');
    expect(admin?.amount).toBe(12957.70);
    expect(accounting?.amount).toBe(4645.17);
    // Pooled '*' NET PAY credit now also splits per cost center (spec: dimension every line):
    // ADMIN row -> 'Net Pay - Admin' (9000), ACCOUN row -> 'Net Pay - Accounting' (3000).
    // Account total is unchanged (9000 + 3000 = the old single 12000 line).
    const netLines = drafts[0]?.lines.filter((l) => l.accountName === 'Payroll Withholdings') ?? [];
    expect(netLines).toHaveLength(2);
    expect(netLines.find((l) => l.memo === 'Net Pay - Admin')?.amount).toBe(9000);
    expect(netLines.find((l) => l.memo === 'Net Pay - Accounting')?.amount).toBe(3000);
  });

  it('orders lines by account then memo so same-account department lines are adjacent', () => {
    // Barbara could not see the Accounting Wages line — it landed far below Admin Wages in the
    // arbitrary bucket order. Lines must come out grouped: Accounting Wages next to Admin Wages,
    // Accounting first (alphabetical memo), regardless of which employee was iterated first.
    const memoAccountMap: AccountMapRule[] = [
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ADMIN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'Admin Wages' },
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'ACCOUN', accountName: 'Payroll Expense -:Administrative Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'Accounting Wages' },
      { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'CS', accountName: 'Payroll Expense -:Customer Service Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'CSR Wages' },
    ];
    // Admin employee iterated FIRST — so without sorting, Admin Wages would precede Accounting Wages.
    const rows = [
      baseRow({ position_id: 'a1', row_key: 'admin1', home_department: 'ADMIN-Administration', sensitive: { 'REGULAR PAY - EARNING': 12957.70 } }),
      baseRow({ position_id: 'cs1', row_key: 'cs1', home_department: 'CS-Customer Service', sensitive: { 'REGULAR PAY - EARNING': 5000 } }),
      baseRow({ position_id: 'c1', row_key: 'acct1', home_department: 'ACCOUN-Accounting', sensitive: { 'REGULAR PAY - EARNING': 4645.17 } }),
    ];
    const lines = buildJournal(rows, memoAccountMap, empMap).drafts[0]?.lines ?? [];
    const memos = lines.map((l) => l.memo);
    const acctIdx = memos.indexOf('Accounting Wages');
    const adminIdx = memos.indexOf('Admin Wages');
    expect(acctIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBe(acctIdx + 1); // adjacent, Accounting immediately before Admin
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

describe('mergeRebuiltLines (rebuild-on-map: refresh generated lines, keep hand-authored ones)', () => {
  const line = (over: Partial<JournalLine>): JournalLine => ({
    postingType: 'Debit', amount: 100, accountName: 'COGS - Lab Wages', departmentName: null,
    className: null, memo: '', creditBucket: null, origin: 'generated', sourceRowKeys: ['k1'], ...over,
  });

  it('replaces every generated line with the freshly-rebuilt set', () => {
    // The draft was built BEFORE a column was mapped, so its generated lines are stale/short.
    const existing = [line({ accountName: 'COGS - Lab Wages', amount: 1000 })];
    // After mapping the missing column, the rebuild produces MORE/updated generated lines.
    const rebuilt = [
      line({ accountName: 'COGS - Lab Wages', amount: 1000 }),
      line({ accountName: 'Employee Advances', amount: 216, postingType: 'Credit', creditBucket: 'Other' }),
    ];
    const merged = mergeRebuiltLines(existing, rebuilt);
    // Old generated lines are gone; the rebuilt set is authoritative for generated lines.
    expect(merged.filter((l) => l.origin === 'generated')).toEqual(rebuilt);
    expect(merged.some((l) => l.accountName === 'Employee Advances')).toBe(true);
  });

  it('preserves accountant-authored manual and inter_entity lines through a rebuild', () => {
    const existing = [
      line({ accountName: 'COGS - Lab Wages', amount: 1000, origin: 'generated' }),
      line({ accountName: 'Payroll Withholdings', amount: 216, postingType: 'Credit', creditBucket: 'Other', memo: 'Variance', origin: 'manual' }),
      line({ accountName: 'Due To MedRock TX', amount: 50, postingType: 'Credit', origin: 'inter_entity' }),
    ];
    const rebuilt = [line({ accountName: 'COGS - Lab Wages', amount: 1200, origin: 'generated' })];
    const merged = mergeRebuiltLines(existing, rebuilt);
    // Rebuilt generated line replaces the stale one...
    expect(merged.find((l) => l.origin === 'generated')?.amount).toBe(1200);
    // ...but the hand-authored manual + inter_entity lines survive untouched.
    const manual = merged.find((l) => l.origin === 'manual');
    const ie = merged.find((l) => l.origin === 'inter_entity');
    expect(manual).toMatchObject({ accountName: 'Payroll Withholdings', amount: 216, memo: 'Variance' });
    expect(ie).toMatchObject({ accountName: 'Due To MedRock TX', amount: 50 });
  });
});

describe('cost-center split', () => {
  const netPayRule: AccountMapRule = { entity: 'MedRock FL', adpColumn: 'NET PAY', costCenter: '*', accountName: 'Payroll Withholdings', postingType: 'Credit', isCogs: false, creditBucket: 'Net Pay', active: true };
  const wagePharm: AccountMapRule = { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'PHARM', accountName: 'Payroll Expense -:Pharm Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'Pharmacists Wages' };
  const wageCs: AccountMapRule = { entity: 'MedRock FL', adpColumn: 'REGULAR PAY - EARNING', costCenter: 'CS', accountName: 'Payroll Expense -:CS Wages', postingType: 'Debit', isCogs: false, creditBucket: null, active: true, memo: 'CSR Wages' };

  it('splits a pooled * credit line into one line per cost center with `<bucket> - <Dept>` memos', () => {
    const rows = [
      baseRow({ position_id: 'N', name: 'Newton', home_department: 'CS-Customer', sensitive: { 'NET PAY': 100 } }),
      baseRow({ position_id: 'P', name: 'Pericot', home_department: 'PHARM-Pharmacy', sensitive: { 'NET PAY': 250 } }),
    ];
    const { drafts } = buildJournal(rows, [netPayRule], []);
    const credits = drafts[0].lines.filter((l) => l.postingType === 'Credit');
    expect(credits).toHaveLength(2);
    expect(credits.map((l) => l.memo).sort()).toEqual(['Net Pay - CSR', 'Net Pay - Pharmacists']);
    const byMemo = Object.fromEntries(credits.map((l) => [l.memo, l.amount]));
    expect(byMemo['Net Pay - CSR']).toBe(100);
    expect(byMemo['Net Pay - Pharmacists']).toBe(250);
  });

  it('leaves cost-center-specific debit lines memo-verbatim (no double suffix)', () => {
    const rows = [
      baseRow({ position_id: 'P', name: 'Pericot', home_department: 'PHARM-Pharmacy', sensitive: { 'REGULAR PAY - EARNING': 500 } }),
      baseRow({ position_id: 'N', name: 'Newton', home_department: 'CS-Customer', sensitive: { 'REGULAR PAY - EARNING': 300 } }),
    ];
    const { drafts } = buildJournal(rows, [wagePharm, wageCs], []);
    const debits = drafts[0].lines.filter((l) => l.postingType === 'Debit');
    expect(debits.map((l) => l.memo).sort()).toEqual(['CSR Wages', 'Pharmacists Wages']);
  });

  it('gives DFLT (blank home_department) rows a bare-base memo, no ` - ` suffix', () => {
    const rows = [baseRow({ position_id: 'X', name: 'Nobody', home_department: '', sensitive: { 'NET PAY': 40 } })];
    const { drafts } = buildJournal(rows, [netPayRule], []);
    const credit = drafts[0].lines.find((l) => l.postingType === 'Credit');
    expect(credit?.memo).toBe('Net Pay');
  });
});

describe('pay-date drafts unchanged by accrual/allocation work', () => {
  it('tags pay-date drafts kind:"pay_date" and carries no special overrides', () => {
    // Reuse the same fixture/setup as the first buildJournal test above.
    const rows = [baseRow({}), baseRow({ position_id: '1001', row_key: 'k2', sensitive: { 'REGULAR PAY - EARNING': 500, 'NET PAY': 400 } })];
    const { drafts } = buildJournal(rows, accountMap, empMap);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.kind).toBe('pay_date');
      expect(d.docNumber).toBeUndefined();
      expect(d.txnDate).toBeUndefined();
      expect(d.privateNote).toBeUndefined();
    }
  });
});
