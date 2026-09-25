import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayrollHeader } from '@/lib/payroll/store';
import type { JournalDraft } from '@/lib/payroll/types';
import type { UnpostOutcome } from '@/lib/payroll/je-unpost';

vi.mock('@/lib/auth', () => ({ requireManager: vi.fn(async () => undefined) }));

const loadDraft = vi.fn(async (..._a: unknown[]) => null as { header: PayrollHeader; lines: JournalDraft['lines'] } | null);
const insertAudit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/payroll/store', () => ({
  loadDraft: (...a: unknown[]) => loadDraft(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
}));

const listEomCorrectionHeaders = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
vi.mock('@/lib/payroll/eom-store', () => ({
  listEomCorrectionHeaders: (...a: unknown[]) => listEomCorrectionHeaders(...a),
}));

const unpostJournalEntry = vi.fn(async (..._a: unknown[]): Promise<UnpostOutcome> => ({
  qbEntryId: '53419',
  qbDocNumber: 'FL CS Allo 2026.08',
  detached: [],
  detachFailed: [],
}));
vi.mock('@/lib/payroll/je-unpost', () => ({
  unpostJournalEntry: (...a: unknown[]) => unpostJournalEntry(...a),
}));

import { POST, isAllocationPayGroup } from './route';
import { NextRequest } from 'next/server';

const base: PayrollHeader = {
  id: 2834, entity: 'MedRock FL', pay_date: '08/31/2026', pay_group: 'CS ALLO',
  period_start: '08/01/2026', period_end: '08/31/2026', status: 'posted',
  total_debits: 10621.97, total_credits: 10621.97, variance: 0, row_count: 6, source_snapshot_hash: 'h',
  qb_entry_id: '53419', qb_doc_number: 'FL CS Allo 2026.08', kind: 'allocation', period_segment: '', txn_date: '2026-08-31',
  piece_count: 1,
};

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/payroll/eom/unpost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  loadDraft.mockReset();
  insertAudit.mockReset();
  unpostJournalEntry.mockClear();
  loadDraft.mockResolvedValue(null);
  listEomCorrectionHeaders.mockReset();
  listEomCorrectionHeaders.mockResolvedValue([]);
});

describe('isAllocationPayGroup', () => {
  it('admits the month-end pool and every CS Allo generation', () => {
    expect(isAllocationPayGroup('EOM')).toBe(true);
    expect(isAllocationPayGroup('CS ALLO')).toBe(true);
    expect(isAllocationPayGroup('CS ALLO 2')).toBe(true);
  });
  it('refuses payroll and inventory groups', () => {
    expect(isAllocationPayGroup('BIWEEKLY')).toBe(false);
    expect(isAllocationPayGroup('INV CLOSE')).toBe(false);
  });
});

describe('POST /api/payroll/eom/unpost', () => {
  it('400s without a headerId', async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
  });

  it('404s an unknown header', async () => {
    const res = await POST(request({ headerId: 1 }));
    expect(res.status).toBe(404);
    expect(unpostJournalEntry).not.toHaveBeenCalled();
  });

  it('400s a header that is not an allocation entry', async () => {
    loadDraft.mockResolvedValue({ header: { ...base, kind: 'inventory', pay_group: 'INV CLOSE' }, lines: [] });
    const res = await POST(request({ headerId: base.id }));
    expect(res.status).toBe(400);
    expect(unpostJournalEntry).not.toHaveBeenCalled();
  });

  it('409s and audits a header that is not posted', async () => {
    loadDraft.mockResolvedValue({ header: { ...base, status: 'needs_review', qb_entry_id: null }, lines: [] });
    const res = await POST(request({ headerId: base.id }));
    expect(res.status).toBe(409);
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ headerId: base.id, outcome: 'blocked' }));
    expect(unpostJournalEntry).not.toHaveBeenCalled();
  });

  it('pulls a posted CS Allo back with the reviewer reason', async () => {
    loadDraft.mockResolvedValue({ header: base, lines: [] });
    const res = await POST(request({ headerId: base.id, reason: 'August top-up wrong' }));
    expect(res.status).toBe(200);
    expect(unpostJournalEntry).toHaveBeenCalledWith(base, 'August top-up wrong');
    const body = (await res.json()) as { ok: boolean; qbDocNumber: string };
    expect(body.ok).toBe(true);
    expect(body.qbDocNumber).toBe('FL CS Allo 2026.08');
  });

  it('falls back to a default reason when none is given', async () => {
    loadDraft.mockResolvedValue({ header: { ...base, pay_group: 'EOM' }, lines: [] });
    await POST(request({ headerId: base.id, reason: '   ' }));
    expect(unpostJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: base.id }),
      'Pulled back from QuickBooks from the End of Month tab to regenerate and repost',
    );
  });

  it('refuses to pull back a parent that has a posted correction', async () => {
    const postedHeader: PayrollHeader = { ...base, id: 9, pay_date: '07/31/2026', qb_doc_number: 'FL % Allo 2026.07' };
    loadDraft.mockResolvedValueOnce({ header: { ...postedHeader, pay_group: 'EOM', period_segment: '' }, lines: [] });
    listEomCorrectionHeaders.mockResolvedValueOnce([
      { ...postedHeader, pay_group: 'EOM', id: 11, period_segment: 'C1', qb_doc_number: 'FL % Allo 2026.07-2' },
    ]);
    const res = await POST(request({ headerId: 9 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('pull back FL % Allo 2026.07-2 first');
    expect(listEomCorrectionHeaders).toHaveBeenCalledWith({ year: 2026, month: 7 });
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ headerId: 9, outcome: 'blocked' }));
    expect(unpostJournalEntry).not.toHaveBeenCalled();
  });

  it('pulls back a parent whose corrections are not posted', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...base, pay_group: 'EOM' }, lines: [] });
    listEomCorrectionHeaders.mockResolvedValueOnce([
      { ...base, pay_group: 'EOM', id: 11, period_segment: 'C1', status: 'approved', qb_entry_id: null },
    ]);
    const res = await POST(request({ headerId: base.id }));
    expect(res.status).toBe(200);
  });
  it('refuses (409, audited) to pull back an EOM parent in a period-complete month (I5)', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...base, pay_group: 'EOM', pay_date: '03/31/2026', qb_doc_number: 'FL % Allo 2026.03' }, lines: [] });
    const res = await POST(request({ headerId: base.id }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('period is complete');
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ headerId: base.id, outcome: 'blocked', reason: expect.stringContaining('period complete') }));
    expect(unpostJournalEntry).not.toHaveBeenCalled();
  });

  it('a correction in a period-complete month stays pullable (I5)', async () => {
    loadDraft.mockResolvedValueOnce({ header: { ...base, pay_group: 'EOM', pay_date: '03/31/2026', period_segment: 'C1' }, lines: [] });
    const res = await POST(request({ headerId: base.id }));
    expect(res.status).toBe(200);
    expect(unpostJournalEntry).toHaveBeenCalled();
  });
});
