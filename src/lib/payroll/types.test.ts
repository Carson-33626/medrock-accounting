import { describe, it, expect } from 'vitest';
import type { PayrollRow, JournalDraft } from './types';

describe('payroll types', () => {
  it('constructs a PayrollRow and JournalDraft', () => {
    const row: PayrollRow = {
      position_id: '1001', name: 'Doe, Jane', status: 'Active', worker_classification: 'W-2 General Employee',
      home_department: 'LAB-Lab', location: 'MEDFL-MedRock FL', pay_date: '06/18/2026', pay_num: '1',
      pay_frequency: 'BI-WEEKLY', pay_group: 'MRFL', pay_type: 'Regular', period_start_date: '06/01/2026',
      period_end_date: '06/14/2026', processed_as: 'Bi-Weekly Payroll', rate_type: 'Hourly',
      sui_sdi_tax_code: 'FL', row_key: '1001|06/18/2026|06/01/2026|06/14/2026|Bi-Weekly Payroll',
      updated_at: '2026-06-19T02:00:00Z', sensitive: { 'GROSS PAY': 1000, 'NET PAY': 800 },
    };
    const draft: JournalDraft = {
      entity: 'MedRock FL', payDate: '06/18/2026', payGroup: 'MRFL', periodStart: '06/01/2026',
      periodEnd: '06/14/2026', lines: [], totalDebits: 0, totalCredits: 0, variance: 0, rowKeys: [row.row_key],
    };
    expect(row.pay_group).toBe('MRFL');
    expect(draft.entity).toBe('MedRock FL');
  });
});
