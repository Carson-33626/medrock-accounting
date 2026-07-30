import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayrollHeader } from '@/lib/payroll/store';
import type { JournalLine } from '@/lib/payroll/types';
import type { PostResult } from '@/lib/payroll/qb-journal';
import type { EomRun } from '@/lib/payroll/eom-store';

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => undefined) }));

const loadDraft = vi.fn(async (..._a: unknown[]) => null as { header: PayrollHeader; lines: JournalLine[] } | null);
const insertAudit = vi.fn(async (..._a: unknown[]) => undefined);
const setHeaderStatus = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/payroll/store', () => ({
  loadDraft: (...a: unknown[]) => loadDraft(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
  setHeaderStatus: (...a: unknown[]) => setHeaderStatus(...a),
}));

const getEomRun = vi.fn(async (..._a: unknown[]) => null as EomRun | null);
vi.mock('@/lib/payroll/eom-store', () => ({
  getEomRun: (...a: unknown[]) => getEomRun(...a),
}));

const postJournalEntry = vi.fn(async (..._a: unknown[]) => ({ mode: 'dry_run', payload: {} }) as PostResult);
vi.mock('@/lib/payroll/qb-journal', () => ({
  postJournalEntry: (...a: unknown[]) => postJournalEntry(...a),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

const header: PayrollHeader = {
  id: 5,
  entity: 'MedRock FL',
  pay_date: '03/31/2026',
  pay_group: 'EOM',
  period_start: '03/01/2026',
  period_end: '03/31/2026',
  status: 'approved',
  total_debits: 100,
  total_credits: 100,
  variance: 0,
  row_count: 0,
  source_snapshot_hash: null,
  qb_entry_id: null,
  qb_doc_number: null,
  kind: 'allocation',
  period_segment: '',
  txn_date: '2026-03-31',
};
const lines: JournalLine[] = [];

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/payroll/eom/post', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  loadDraft.mockReset();
  insertAudit.mockReset();
  setHeaderStatus.mockReset();
  getEomRun.mockReset();
  postJournalEntry.mockReset();

  loadDraft.mockResolvedValue({ header, lines });
  insertAudit.mockResolvedValue(undefined);
  setHeaderStatus.mockResolvedValue(undefined);
  getEomRun.mockResolvedValue(null);
  postJournalEntry.mockResolvedValue({ mode: 'dry_run', payload: {} } as PostResult);
});

describe('POST /api/payroll/eom/post', () => {
  it('404s when header not found', async () => {
    loadDraft.mockResolvedValueOnce(null);
    const res = await POST(req({ headerId: 999, mode: 'dry_run' }));
    expect(res.status).toBe(404);
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('400s when header kind is not allocation (wrong route for payroll drafts)', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, kind: 'pay_date' }, lines });
    const res = await POST(req({ headerId: 5, mode: 'dry_run' }));
    expect(res.status).toBe(400);
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('dry_run bypasses the approval gate and never calls setHeaderStatus', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, status: 'needs_review' }, lines });
    const res = await POST(req({ headerId: 5, mode: 'dry_run' }));
    expect(res.status).toBe(200);
    expect(postJournalEntry).toHaveBeenCalledWith('MedRock FL', expect.anything(), { mode: 'dry_run' });
    expect(setHeaderStatus).not.toHaveBeenCalled();
  });

  it('live blocked on unapproved status -> 409 + audited blocked', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, status: 'needs_review' }, lines });
    const res = await POST(req({ headerId: 5, mode: 'live' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('must be approved before posting');
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', reason: 'must be approved before posting' }));
  });

  it('live blocked when already posted (qb_entry_id set) -> 409, never calls postJournalEntry', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, qb_entry_id: 'qb-1' }, lines });
    const res = await POST(req({ headerId: 5, mode: 'live' }));
    expect(res.status).toBe(409);
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', reason: 'already posted' }));
  });

  it('live blocked when status already posted (even without qb_entry_id) -> 409', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, status: 'posted' }, lines });
    const res = await POST(req({ headerId: 5, mode: 'live' }));
    expect(res.status).toBe(409);
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('live blocked when variance != 0 -> 409 draft unbalanced', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...header, variance: 5 }, lines });
    const res = await POST(req({ headerId: 5, mode: 'live' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft unbalanced');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('live success: posts + flips status to posted with entryId/docNumber', async () => {
    postJournalEntry.mockResolvedValueOnce({
      mode: 'live', payload: { DocNumber: 'FL % Allo 2026.03', TxnDate: '2026-03-31', Line: [] },
      qbEntryId: 'qb-99', qbDocNumber: 'FL % Allo 2026.03',
    } as PostResult);
    const res = await POST(req({ headerId: 5, mode: 'live' }));
    expect(res.status).toBe(200);
    expect(postJournalEntry).toHaveBeenCalledWith('MedRock FL', expect.anything(), { mode: 'live' });
    expect(setHeaderStatus).toHaveBeenCalledWith(5, 'posted', { entryId: 'qb-99', docNumber: 'FL % Allo 2026.03' });
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'posted' }));
  });

  it('live success calls setHeaderStatus before insertAudit writes the posted outcome (double-post guard)', async () => {
    postJournalEntry.mockResolvedValueOnce({
      mode: 'live', payload: { DocNumber: 'FL % Allo 2026.03', TxnDate: '2026-03-31', Line: [] },
      qbEntryId: 'qb-99', qbDocNumber: 'FL % Allo 2026.03',
    } as PostResult);
    await POST(req({ headerId: 5, mode: 'live' }));

    const setHeaderStatusOrder = setHeaderStatus.mock.invocationCallOrder[0];
    const postedAuditCall = insertAudit.mock.calls.findIndex(
      (call) => (call[0] as { outcome: string }).outcome === 'posted',
    );
    const postedAuditOrder = insertAudit.mock.invocationCallOrder[postedAuditCall];
    expect(setHeaderStatusOrder).toBeLessThan(postedAuditOrder);
  });

  it('derives the docNumber/privateNote from header.pay_date and posts a balanced allocation draft', async () => {
    await POST(req({ headerId: 5, mode: 'dry_run' }));
    const draftArg = postJournalEntry.mock.calls[0][1] as { docNumber: string; privateNote: string; kind: string };
    expect(draftArg.docNumber).toBe('FL % Allo 2026.03');
    expect(draftArg.privateNote).toBe('Month-end allocation — 2026-03');
    expect(draftArg.kind).toBe('allocation');
  });
});
