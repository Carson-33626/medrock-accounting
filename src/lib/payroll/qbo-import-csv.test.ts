import { describe, it, expect } from 'vitest';
import { buildQboImportRows, isoToQboDate, qboImportFilename, type QboImportJe } from './qbo-import-csv';
import { deriveJeIdentity, type JeIdentityHeader } from './je-identity';
import type { JournalLine } from './types';

const line = (over: Partial<JournalLine>): JournalLine => ({
  postingType: 'Debit', amount: 100, accountName: 'Payroll Expense -:Administrative Wages',
  departmentName: null, className: null, memo: '', creditBucket: null, origin: 'generated', sourceRowKeys: [],
  ...over,
});

describe('isoToQboDate', () => {
  it('renders MM/DD/YYYY', () => {
    expect(isoToQboDate('2026-07-31')).toBe('07/31/2026');
  });
  it('throws on garbage rather than emitting a mis-parsable row', () => {
    expect(() => isoToQboDate('07/31/2026')).toThrow();
  });
});

describe('buildQboImportRows', () => {
  const je: QboImportJe = {
    docNumber: 'FL % Allo 2026.07',
    txnDateIso: '2026-07-31',
    privateNote: 'Month-end allocation — July 2026',
    lines: [
      line({ postingType: 'Credit', amount: 39680.955, accountName: 'Payroll Expense -:Administrative Wages', memo: 'Allocation of Administrative Wages — revenue % split' }),
      line({ postingType: 'Debit', amount: 29426.73, accountName: 'Due from MedRock TN, LLC', memo: 'Month-end allocation — net with TN' }),
    ],
  };

  it('emits one row per line with Debits XOR Credits as plain 2dp strings', () => {
    const rows = buildQboImportRows([je]);
    expect(rows).toHaveLength(2);
    const credit = rows.find((r) => r.credits !== '');
    const debit = rows.find((r) => r.debits !== '');
    expect(credit).toMatchObject({
      journalNo: 'FL % Allo 2026.07',
      accountName: 'Payroll Expense -:Administrative Wages', credits: '39680.96', debits: '',
      description: 'Allocation of Administrative Wages — revenue % split',
    });
    expect(debit).toMatchObject({ accountName: 'Due from MedRock TN, LLC', debits: '29426.73', credits: '' });
  });

  it('mirrors the Intuit sample: date + USD only on each JE first row, blank after', () => {
    const rows = buildQboImportRows([je]);
    expect(rows[0]).toMatchObject({ journalDate: '07/31/2026', currency: 'USD', name: '' });
    expect(rows[1]).toMatchObject({ journalDate: '', currency: '' });
  });

  it('carries department as Location and class as Class', () => {
    const rows = buildQboImportRows([{ ...je, lines: [line({ departmentName: '% Allocation', className: 'Allocate - %' })] }]);
    expect(rows[0]).toMatchObject({ location: '% Allocation', className: 'Allocate - %' });
  });

  it('account names stay bare FQNs — numbered names fail the wizard too; numbers-off import matches bare names', () => {
    const bare = ['Due from MedRock TN, LLC', 'Payroll Expense -:Administrative Wages'];
    expect(buildQboImportRows([je]).map((r) => r.accountName).sort()).toEqual(bare);
  });

  it('groups a split run as multiple JournalNos in one file, with no TOTAL row', () => {
    const rows = buildQboImportRows([
      { docNumber: 'PR 2026.07.01A', txnDateIso: '2026-06-30', privateNote: null, lines: [line({})] },
      { docNumber: 'PR 2026.07.01B', txnDateIso: '2026-07-01', privateNote: null, lines: [line({})] },
    ]);
    expect(rows.map((r) => r.journalNo)).toEqual(['PR 2026.07.01A', 'PR 2026.07.01B']);
    expect(rows.every((r) => r.accountName !== '' && r.journalNo !== 'TOTAL')).toBe(true);
  });
});

describe('qboImportFilename', () => {
  it('single JE carries its doc number', () => {
    expect(qboImportFilename('MedRock FL', [{ docNumber: 'FL % Allo 2026.07', txnDateIso: '2026-07-31', privateNote: null, lines: [] }]))
      .toBe('QBO_Import_MedRock_FL_FL_Allo_2026.07');
  });
});

describe('deriveJeIdentity', () => {
  const base: JeIdentityHeader = {
    entity: 'MedRock FL', kind: 'pay_date', pay_date: '07/17/2026', pay_group: 'MRFL',
    period_segment: '', period_start: '06/29/2026', period_end: '07/12/2026',
    txn_date: '2026-07-17', qb_doc_number: null,
  };

  it('pay_date single piece: PR doc number + Auto payroll note', () => {
    expect(deriveJeIdentity(base, 0, 1)).toEqual({
      docNumber: 'PR 2026.07.17', txnDateIso: '2026-07-17',
      privateNote: 'Auto payroll JE — MRFL 07/17/2026',
    });
  });

  it('pay_date split piece: suffixed doc number + Split i/n note', () => {
    const id = deriveJeIdentity({ ...base, pay_date: '07/01/2026', txn_date: '2026-06-30', period_segment: '2026-06' }, 0, 2);
    expect(id.docNumber).toBe('PR 2026.07.01A');
    expect(id.privateNote).toBe('Split 1/2 of PR 2026.07.01 — period 06/29/2026–07/12/2026');
  });

  it('allocation: eom doc number from txn_date month', () => {
    const id = deriveJeIdentity({ ...base, kind: 'allocation', pay_date: '07/31/2026', pay_group: 'EOM', txn_date: '2026-07-31' }, 0, 1);
    expect(id).toEqual({
      docNumber: 'FL % Allo 2026.07', txnDateIso: '2026-07-31',
      privateNote: 'Month-end allocation — July 2026',
    });
  });

  it('inventory: Inv Adj doc number from txn_date month', () => {
    const id = deriveJeIdentity({ ...base, kind: 'inventory', pay_date: '08/31/2026', pay_group: 'EOM', txn_date: '2026-08-31' }, 0, 1);
    expect(id.docNumber).toBe('FL Inv Adj 2026.08');
    expect(id.privateNote).toBe('Inventory FIFO close adjustment — 2026-08');
  });

  it('prefers a posted qb_doc_number over the derivation', () => {
    expect(deriveJeIdentity({ ...base, qb_doc_number: 'PR 2026.07.17 MANUAL' }, 0, 1).docNumber).toBe('PR 2026.07.17 MANUAL');
  });
});
