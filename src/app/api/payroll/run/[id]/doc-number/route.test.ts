import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayrollHeader } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => undefined) }));

const loadDraft = vi.fn(async (..._a: unknown[]) => null as { header: PayrollHeader; lines: JournalLine[] } | null);
const listSiblings = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
const setHeaderDocNumber = vi.fn(async (..._a: unknown[]) => true);
const insertAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/payroll/store', () => ({
  loadDraft: (...a: unknown[]) => loadDraft(...a),
  listSiblings: (...a: unknown[]) => listSiblings(...a),
  setHeaderDocNumber: (...a: unknown[]) => setHeaderDocNumber(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
}));

interface RawJe { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: unknown[] }
const qbQueryAll = vi.fn(async (..._a: unknown[]) => [] as RawJe[]);
vi.mock('@/lib/quickbooks-multi', () => ({
  qbQueryAll: (...a: unknown[]) => qbQueryAll(...a),
}));

import { GET, PATCH } from './route';
import { NextRequest } from 'next/server';

const header: PayrollHeader = {
  id: 555,
  entity: 'MedRock FL',
  pay_date: '07/21/2026',
  pay_group: 'MRFL',
  period_start: '07/06/2026',
  period_end: '07/19/2026',
  status: 'approved',
  total_debits: 2691.25,
  total_credits: 2691.25,
  variance: 0,
  row_count: 1,
  source_snapshot_hash: 'abc',
  qb_entry_id: null,
  qb_doc_number: null,
  kind: 'pay_date',
  period_segment: '',
  txn_date: '2026-07-21',
  piece_count: 1,
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown): NextRequest =>
  new NextRequest('http://x/api/payroll/run/555/doc-number', { method: 'PATCH', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  loadDraft.mockResolvedValue({ header, lines: [] });
  listSiblings.mockResolvedValue([header]);
  setHeaderDocNumber.mockResolvedValue(true);
  qbQueryAll.mockResolvedValue([]);
});

describe('GET (who holds this run\'s Doc No)', () => {
  it('names the conflicting entry and suggests the next free number', async () => {
    qbQueryAll.mockResolvedValue([
      {
        Id: '53320',
        DocNumber: 'PR 2026.07.21',
        TxnDate: '2026-08-31',
        PrivateNote: '',
        Line: [
          { Amount: 7948.33, JournalEntryLineDetail: { PostingType: 'Debit' } },
          { Amount: 7948.33, JournalEntryLineDetail: { PostingType: 'Credit' } },
        ],
      },
    ]);

    const res = await GET(new NextRequest('http://x'), ctx('555'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.docNumber).toBe('PR 2026.07.21');
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].qbEntryId).toBe('53320');
    expect(body.conflicts[0].txnDate).toBe('2026-08-31');
    // Debit side only — not the doubled debit+credit total.
    expect(body.conflicts[0].amount).toBe(7948.33);
    expect(body.suggestedDocNumber).toBe('PR 2026.07.21-2');
  });

  it('suggests past suffixes that are also taken', async () => {
    qbQueryAll.mockResolvedValue([
      { Id: '1', DocNumber: 'PR 2026.07.21', Line: [] },
      { Id: '2', DocNumber: 'PR 2026.07.21-2', Line: [] },
    ]);
    const body = await (await GET(new NextRequest('http://x'), ctx('555'))).json();
    expect(body.suggestedDocNumber).toBe('PR 2026.07.21-3');
  });

  it('reports no conflict when the number is free', async () => {
    const body = await (await GET(new NextRequest('http://x'), ctx('555'))).json();
    expect(body.conflicts).toEqual([]);
    expect(body.overridden).toBe(false);
  });

  it('resolves the suffix off the BASE number when the run is already renamed', async () => {
    loadDraft.mockResolvedValue({ header: { ...header, qb_doc_number: 'PR 2026.07.21-2' }, lines: [] });
    listSiblings.mockResolvedValue([{ ...header, qb_doc_number: 'PR 2026.07.21-2' }]);
    qbQueryAll.mockResolvedValue([
      { Id: '1', DocNumber: 'PR 2026.07.21', Line: [] },
      { Id: '2', DocNumber: 'PR 2026.07.21-2', Line: [] },
    ]);
    const body = await (await GET(new NextRequest('http://x'), ctx('555'))).json();
    expect(body.baseDocNumber).toBe('PR 2026.07.21');
    expect(body.docNumber).toBe('PR 2026.07.21-2');
    expect(body.overridden).toBe(true);
    // Not 'PR 2026.07.21-2-2'.
    expect(body.suggestedDocNumber).toBe('PR 2026.07.21-3');
  });

  it('404s an unknown header', async () => {
    loadDraft.mockResolvedValue(null);
    const res = await GET(new NextRequest('http://x'), ctx('999'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH (rename this run)', () => {
  it('pins a valid suffix and audits it', async () => {
    const res = await PATCH(patchReq({ docNumber: 'PR 2026.07.21-2' }), ctx('555'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.docNumber).toBe('PR 2026.07.21-2');
    expect(setHeaderDocNumber).toHaveBeenCalledWith(555, 'PR 2026.07.21-2');
    expect(insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ headerId: 555, outcome: 'doc_number_renamed' }),
    );
  });

  it('refuses a DocNumber that is not a suffix of the derived one', async () => {
    const res = await PATCH(patchReq({ docNumber: 'MY OWN NUMBER' }), ctx('555'));
    expect(res.status).toBe(400);
    expect(setHeaderDocNumber).not.toHaveBeenCalled();
  });

  it('re-checks QuickBooks and refuses a suffix taken since the GET', async () => {
    qbQueryAll.mockResolvedValue([{ Id: '77777', DocNumber: 'PR 2026.07.21-2', Line: [] }]);
    const res = await PATCH(patchReq({ docNumber: 'PR 2026.07.21-2' }), ctx('555'));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('77777');
    expect(setHeaderDocNumber).not.toHaveBeenCalled();
  });

  it('refuses a run in a closed period', async () => {
    loadDraft.mockResolvedValue({ header: { ...header, pay_date: '01/30/2026' }, lines: [] });
    listSiblings.mockResolvedValue([{ ...header, pay_date: '01/30/2026' }]);
    const res = await PATCH(patchReq({ docNumber: 'PR 2026.01.30-2' }), ctx('555'));
    expect(res.status).toBe(409);
    expect(setHeaderDocNumber).not.toHaveBeenCalled();
  });

  it('refuses a posted run (store rejects the update)', async () => {
    setHeaderDocNumber.mockResolvedValue(false);
    const res = await PATCH(patchReq({ docNumber: 'PR 2026.07.21-2' }), ctx('555'));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toContain('already posted');
  });

  it('clears the override without touching QuickBooks', async () => {
    const res = await PATCH(patchReq({ docNumber: null }), ctx('555'));
    expect(res.status).toBe(200);
    expect(qbQueryAll).not.toHaveBeenCalled();
    expect(setHeaderDocNumber).toHaveBeenCalledWith(555, null);
  });
});
