import { describe, it, expect } from 'vitest';
import { buildPatchPayload, buildMemo } from './payload-builder';
import type { QBEntry, CodingMap } from './types';

const coding: CodingMap = {
  gl: { '221': '221', '285': '285' },
  klass: { '10': '10' },
  location: { '5': '5' },
};

function entry(p: Partial<QBEntry>): QBEntry {
  return {
    realm: 'FL', qbEntryId: 'q1', docType: 'Purchase', orderNo: '111-2222222-3333333',
    txnDate: '2026-03-10', totalCents: 3000, vendor: 'Amazon Business',
    lines: [
      { description: 'Pens', amountCents: 1000, glAccountId: '221', glAccountName: 'Suspense', classId: '10', locationId: '5' },
      { description: 'Paper', amountCents: 2000, glAccountId: '285', glAccountName: 'Airfare', classId: null, locationId: '5' },
    ],
    ...p,
  };
}

describe('buildPatchPayload', () => {
  it('builds one line item per QB line with GL + Class selections', () => {
    const { payload, flags } = buildPatchPayload(entry({}), coding);
    expect(flags).toHaveLength(0);
    expect(payload.line_items).toHaveLength(2);
    expect(payload.line_items[0].amount).toBe(1000);
    expect(payload.line_items[0].accounting_field_selections).toEqual([
      { field_external_id: 'QuickbooksCategory', field_option_external_id: '221' },
      { field_external_id: 'QuickbooksClass', field_option_external_id: '10' },
      { field_external_id: 'QuickbooksDepartment', field_option_external_id: '5' },
    ]);
  });

  it('flags (and omits) a GL account not in the coding map', () => {
    const e = entry({ lines: [{ description: 'X', amountCents: 500, glAccountId: '999', glAccountName: 'Mystery', classId: null, locationId: null }] });
    const { payload, flags } = buildPatchPayload(e, coding);
    expect(flags.some((f) => f.includes('999'))).toBe(true);
    expect(payload.line_items[0].accounting_field_selections).toHaveLength(0);
  });
});

describe('buildMemo', () => {
  it('formats the audit memo with order# and line count', () => {
    expect(buildMemo(entry({})).memo).toBe('Matched to QB Amazon order# 111-2222222-3333333 (2 items)');
  });
});
