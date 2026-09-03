import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditEntry, PayrollHeader } from './store';
import type { QbAttachable } from '@/lib/quickbooks-multi';
import type { JournalLine } from './types';
import type { AttachDeps } from './je-attach';

const insertAudit = vi.fn<(entry: AuditEntry) => Promise<void>>(async () => undefined);
const hasAttachedFile = vi.fn<(headerId: number, fileName: string) => Promise<boolean>>(async () => false);
vi.mock('./store', () => ({
  insertAudit: (e: AuditEntry) => insertAudit(e),
  hasAttachedFile: (id: number, name: string) => hasAttachedFile(id, name),
}));

vi.mock('./je-workbook', () => ({
  buildJeSourceWorkbook: async () => ({
    sheets: [
      { name: 'Journal Entry', columns: [{ header: 'Account', key: 'account' }], rows: [{ account: '6000.10' }] },
      { name: 'ADP source detail', columns: [{ header: 'Account', key: 'account' }], rows: [{ account: '6000.10' }] },
    ],
    filename: 'JE_MedRock_FL_PR_2026.07.01',
    note: 'note',
    docNumber: 'PR 2026.07.01',
    txnDate: '2026-07-01',
  }),
}));

import { attachJeWorkbook, jeAttachmentFileName } from './je-attach';

const FILE = 'JE_MedRock_FL_PR_2026.07.01_source.xlsx';

const header: PayrollHeader = {
  id: 4242,
  entity: 'MedRock FL',
  pay_date: '07/01/2026',
  pay_group: 'FLSAL',
  period_start: '06/16/2026',
  period_end: '06/30/2026',
  status: 'posted',
  total_debits: 1000,
  total_credits: 1000,
  variance: 0,
  row_count: 12,
  source_snapshot_hash: 'abc',
  qb_entry_id: '991',
  qb_doc_number: null,
  kind: 'pay_date',
  period_segment: '',
  txn_date: '2026-07-01',
  piece_count: 1,
};

const lines: JournalLine[] = [
  { postingType: 'Debit', amount: 1000, accountName: '6000.10 Administrative Wages', departmentName: 'Admin', className: null, memo: 'Wages', creditBucket: null, origin: 'generated', sourceRowKeys: ['r1'] },
];

function deps(overrides: Partial<AttachDeps> = {}): AttachDeps {
  return {
    upload: vi.fn(async (): Promise<QbAttachable> => ({ Id: 'att-1', FileName: FILE })),
    listAttachables: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  insertAudit.mockReset();
  insertAudit.mockResolvedValue(undefined);
  hasAttachedFile.mockReset();
  hasAttachedFile.mockResolvedValue(false);
});

describe('attachJeWorkbook', () => {
  it('uploads the workbook to the posted entry and records the Attachable id', async () => {
    const d = deps();
    const out = await attachJeWorkbook(header, lines, { entryId: '991', docNumber: 'PR 2026.07.01' }, d);

    expect(out).toMatchObject({ status: 'attached', fileName: FILE, attachableId: 'att-1' });
    expect(out.sheets).toEqual(['Journal Entry', 'ADP source detail']);

    const call = vi.mocked(d.upload).mock.calls[0];
    expect(call[0]).toBe('MedRock FL');
    expect(call[1].entityRef).toEqual({ type: 'JournalEntry', value: '991' });
    expect(call[1].contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Real .xlsx bytes, not an empty buffer: the zip magic number.
    expect(call[1].bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    expect(insertAudit).toHaveBeenCalledTimes(1);
    expect(insertAudit.mock.calls[0][0]).toMatchObject({ headerId: 4242, outcome: 'attached', qbEntryId: '991' });
  });

  it('an upload failure NEVER throws — it returns failed and audits it', async () => {
    // The JE is already live in QuickBooks by this point. A throw here would surface as a
    // failed post on an entry that posted fine (DS §3.3).
    const d = deps({ upload: vi.fn(async () => { throw new Error('QB upload error for MedRock FL: 400 unsupported content type'); }) });

    const out = await attachJeWorkbook(header, lines, { entryId: '991' }, d);

    expect(out.status).toBe('failed');
    expect(out.reason).toContain('unsupported content type');
    expect(insertAudit).toHaveBeenCalledTimes(1);
    expect(insertAudit.mock.calls[0][0]).toMatchObject({
      headerId: 4242,
      outcome: 'attach_error',
      qbEntryId: '991',
      mode: 'live',
    });
    expect(insertAudit.mock.calls[0][0].reason).toContain('unsupported content type');
  });

  it('a failing audit write is still not allowed to throw', async () => {
    insertAudit.mockRejectedValue(new Error('RDS unreachable'));
    const d = deps({ upload: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(attachJeWorkbook(header, lines, { entryId: '991' }, d)).resolves.toMatchObject({ status: 'failed' });
  });

  it('skips a file our audit trail says is already attached, and uploads nothing', async () => {
    hasAttachedFile.mockResolvedValue(true);
    const d = deps();

    const out = await attachJeWorkbook(header, lines, { entryId: '991' }, d);

    expect(out).toMatchObject({ status: 'skipped', reason: 'already attached' });
    expect(d.upload).not.toHaveBeenCalled();
    expect(insertAudit).not.toHaveBeenCalled();
    expect(hasAttachedFile).toHaveBeenCalledWith(4242, FILE);
  });

  it('skips a file QuickBooks already holds under the same deterministic name', async () => {
    const d = deps({ listAttachables: vi.fn(async () => [{ Id: 'att-old' }]) });
    const out = await attachJeWorkbook(header, lines, { entryId: '991' }, d);
    expect(out.status).toBe('skipped');
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('an Attachable lookup that fails does not block a first attachment', async () => {
    // The query surface for Attachable is unverified; its failure must not be read as
    // "already attached" and leave an entry with no file at all.
    const d = deps({ listAttachables: vi.fn(async () => { throw new Error('400 query not supported'); }) });
    const out = await attachJeWorkbook(header, lines, { entryId: '991' }, d);
    expect(out.status).toBe('attached');
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('names the file deterministically off the entry, so a retry compares by string', () => {
    expect(jeAttachmentFileName('JE_MedRock_FL_PR_2026.07.01')).toBe(FILE);
  });
});
