import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EomRun } from '@/lib/payroll/eom-store';
import type { PayrollHeader } from '@/lib/payroll/store';
import type { JournalDraft } from '@/lib/payroll/types';

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => undefined) }));

const getEomRun = vi.fn(async (..._a: unknown[]) => null as EomRun | null);
const listEomHeaders = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
vi.mock('@/lib/payroll/eom-store', () => ({
  getEomRun: (...a: unknown[]) => getEomRun(...a),
  listEomHeaders: (...a: unknown[]) => listEomHeaders(...a),
}));

const loadDraft = vi.fn(async (..._a: unknown[]) => null as { header: PayrollHeader; lines: JournalDraft['lines'] } | null);
vi.mock('@/lib/payroll/store', () => ({
  loadDraft: (...a: unknown[]) => loadDraft(...a),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';

const header: PayrollHeader = {
  id: 101, entity: 'MedRock FL', pay_date: '03/31/2026', pay_group: 'EOM',
  period_start: '03/01/2026', period_end: '03/31/2026', status: 'needs_review',
  total_debits: 0, total_credits: 0, variance: 0, row_count: 0, source_snapshot_hash: 'h',
  qb_entry_id: null, qb_doc_number: null, kind: 'allocation', period_segment: '', txn_date: '2026-03-31',
};

beforeEach(() => {
  getEomRun.mockReset();
  listEomHeaders.mockReset();
  loadDraft.mockReset();
  getEomRun.mockResolvedValue(null);
  listEomHeaders.mockResolvedValue([]);
  loadDraft.mockResolvedValue(null);
});

function req(qs: string): NextRequest {
  return new NextRequest(`http://x/api/payroll/eom${qs}`);
}

describe('GET /api/payroll/eom', () => {
  it('400s on a badly-formed month', async () => {
    const res = await GET(req('?month=2026/03'));
    expect(res.status).toBe(400);
  });

  it('empty state (no run generated yet) returns run: null, headers: []', async () => {
    const res = await GET(req('?month=2026-03'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: unknown; headers: unknown[]; lines: Record<string, unknown> };
    expect(body).toEqual({ run: null, headers: [], lines: {} });
  });

  it('maps headers to their persisted lines by header id', async () => {
    listEomHeaders.mockResolvedValueOnce([header]);
    loadDraft.mockResolvedValueOnce({ header, lines: [] });
    const res = await GET(req('?month=2026-03'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { headers: PayrollHeader[]; lines: Record<string, unknown[]> };
    expect(body.headers).toEqual([header]);
    expect(body.lines).toEqual({ '101': [] });
    expect(loadDraft).toHaveBeenCalledWith(101);
  });
});
