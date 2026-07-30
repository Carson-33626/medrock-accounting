import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RevenueTest } from '@/lib/payroll/revenue-rule';
import type { PoolLine } from '@/lib/payroll/qb-pool';
import type { JournalDraft } from '@/lib/payroll/types';
import type { PayrollHeader } from '@/lib/payroll/store';
import type { Refs } from '@/lib/payroll/qb-journal';

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => undefined) }));

const fetchRevenuePresence = vi.fn(async (..._a: unknown[]) => ({}) as RevenueTest);
const sharesFromPresence = vi.fn((..._a: unknown[]) => ({}) as Record<string, number> | null);
vi.mock('@/lib/payroll/revenue-rule', () => ({
  EOM_ENTITIES: ['MedRock FL', 'MedRock TN', 'MedRock TX'],
  fetchRevenuePresence: (...a: unknown[]) => fetchRevenuePresence(...a),
  sharesFromPresence: (...a: unknown[]) => sharesFromPresence(...a),
}));

const fetchAllocationPool = vi.fn(async (..._a: unknown[]) => ({ pool: [] as PoolLine[], attention: [] as PoolLine[] }));
vi.mock('@/lib/payroll/qb-pool', () => ({
  fetchAllocationPool: (...a: unknown[]) => fetchAllocationPool(...a),
}));

const buildMonthEndAllocation = vi.fn((..._a: unknown[]) => [] as JournalDraft[]);
vi.mock('@/lib/payroll/month-end', () => ({
  buildMonthEndAllocation: (...a: unknown[]) => buildMonthEndAllocation(...a),
}));

const saveEomRun = vi.fn(async (..._a: unknown[]) => undefined);
const listEomHeaders = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
const deleteUnpostedEomHeaders = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('@/lib/payroll/eom-store', () => ({
  saveEomRun: (...a: unknown[]) => saveEomRun(...a),
  listEomHeaders: (...a: unknown[]) => listEomHeaders(...a),
  deleteUnpostedEomHeaders: (...a: unknown[]) => deleteUnpostedEomHeaders(...a),
}));

const saveDraft = vi.fn(async (..._a: unknown[]) => 1);
const loadDraft = vi.fn(async (..._a: unknown[]) => null as { header: PayrollHeader; lines: JournalDraft['lines'] } | null);
vi.mock('@/lib/payroll/store', () => ({
  saveDraft: (...a: unknown[]) => saveDraft(...a),
  loadDraft: (...a: unknown[]) => loadDraft(...a),
}));

const fetchDimensions = vi.fn(async (..._a: unknown[]) => ({ accounts: {}, departments: {}, classes: {} }) as Refs);
vi.mock('@/lib/payroll/qb-journal', () => ({
  fetchDimensions: (...a: unknown[]) => fetchDimensions(...a),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

const revenueTestFixture: RevenueTest = {
  month: '2026-03',
  income: { 'MedRock FL': 100, 'MedRock TN': 0, 'MedRock TX': 0 },
};
const sharesFixture: Record<string, number> = { 'MedRock FL': 100, 'MedRock TN': 0, 'MedRock TX': 0 };

const postedHeader: PayrollHeader = {
  id: 1,
  entity: 'MedRock FL',
  pay_date: '03/31/2026',
  pay_group: 'EOM',
  period_start: '03/01/2026',
  period_end: '03/31/2026',
  status: 'posted',
  total_debits: 0,
  total_credits: 0,
  variance: 0,
  row_count: 0,
  source_snapshot_hash: null,
  qb_entry_id: 'qb-1',
  qb_doc_number: 'FL % Allo 2026.03',
  kind: 'allocation',
  period_segment: '',
  txn_date: '2026-03-31',
};

const revenuePoolLine: PoolLine = {
  entity: 'MedRock FL',
  txnType: 'JournalEntry',
  txnId: 'je-1',
  txnDate: '2026-03-15',
  docNumber: null,
  accountName: 'Rent Expense',
  className: 'Allocate - %',
  departmentName: null,
  memo: null,
  amount: 900,
  rule: 'revenue',
  counterparty: null,
};

function draftFixture(entity: JournalDraft['entity']): JournalDraft {
  return {
    entity,
    payDate: '03/31/2026',
    payGroup: 'EOM',
    periodStart: '03/01/2026',
    periodEnd: '03/31/2026',
    lines: [],
    totalDebits: 0,
    totalCredits: 0,
    variance: 0,
    rowKeys: [],
  };
}

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/payroll/eom/generate', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  fetchRevenuePresence.mockReset();
  sharesFromPresence.mockReset();
  fetchAllocationPool.mockReset();
  buildMonthEndAllocation.mockReset();
  saveEomRun.mockReset();
  listEomHeaders.mockReset();
  deleteUnpostedEomHeaders.mockReset();
  saveDraft.mockReset();
  loadDraft.mockReset();
  fetchDimensions.mockReset();

  fetchRevenuePresence.mockResolvedValue(revenueTestFixture);
  sharesFromPresence.mockReturnValue(sharesFixture);
  fetchAllocationPool.mockResolvedValue({ pool: [], attention: [] });
  buildMonthEndAllocation.mockReturnValue([]);
  listEomHeaders.mockResolvedValue([]);
  deleteUnpostedEomHeaders.mockResolvedValue(0);
  saveDraft.mockResolvedValue(1);
  loadDraft.mockResolvedValue(null);
  fetchDimensions.mockResolvedValue({ accounts: {}, departments: {}, classes: {} });
});

describe('POST /api/payroll/eom/generate', () => {
  it('400s on a badly-formed month', async () => {
    const res = await POST(req({ month: '2026/03' }));
    expect(res.status).toBe(400);
  });

  it('409 short-circuits before any QuickBooks fetch when the month has a posted header', async () => {
    listEomHeaders.mockResolvedValueOnce([postedHeader]);
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/regeneration locked/);
    expect(body.error).toContain('FL % Allo 2026.03');
    expect(fetchRevenuePresence).not.toHaveBeenCalled();
    expect(fetchAllocationPool).not.toHaveBeenCalled();
  });

  it('502s when QuickBooks is unreachable', async () => {
    fetchRevenuePresence.mockRejectedValueOnce(new Error('QuickBooks not connected for location: MedRock TX'));
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/QuickBooks not connected/);
  });

  it('422s when shares are null and the pool has a revenue-rule line', async () => {
    sharesFromPresence.mockReturnValueOnce(null);
    fetchAllocationPool.mockResolvedValueOnce({ pool: [revenuePoolLine], attention: [] });
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no location has revenue for 2026-03');
  });

  it('falls back to zero shares (no 422) when shares are null but no revenue-rule line exists', async () => {
    sharesFromPresence.mockReturnValueOnce(null);
    fetchAllocationPool.mockResolvedValueOnce({ pool: [], attention: [] });
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(200);
    expect(buildMonthEndAllocation).toHaveBeenCalledWith(
      [],
      { 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 },
      { year: 2026, month: 3 },
    );
  });

  it('happy path: saveDraft per draft, then deleteUnpostedEomHeaders, then saveEomRun (in that order)', async () => {
    const drafts = [draftFixture('MedRock FL'), draftFixture('MedRock TN')];
    buildMonthEndAllocation.mockReturnValueOnce(drafts);
    saveDraft.mockResolvedValueOnce(101).mockResolvedValueOnce(102);
    loadDraft.mockResolvedValue({ header: { ...postedHeader, id: 101, status: 'needs_review' }, lines: [] });

    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(200);

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(deleteUnpostedEomHeaders).toHaveBeenCalledWith({ year: 2026, month: 3 }, ['MedRock FL', 'MedRock TN']);
    expect(saveEomRun).toHaveBeenCalledTimes(1);

    const lastSaveDraftOrder = saveDraft.mock.invocationCallOrder[1];
    const deleteOrder = deleteUnpostedEomHeaders.mock.invocationCallOrder[0];
    const saveRunOrder = saveEomRun.mock.invocationCallOrder[0];
    expect(lastSaveDraftOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(saveRunOrder);

    const body = (await res.json()) as { drafts: Array<{ headerId: number; entity: string }> };
    expect(body.drafts).toEqual([
      { headerId: 101, entity: 'MedRock FL', lines: [] },
      { headerId: 102, entity: 'MedRock TN', lines: [] },
    ]);
  });

  it('collects a warning when fetchDimensions fails for a draft entity', async () => {
    buildMonthEndAllocation.mockReturnValueOnce([draftFixture('MedRock FL')]);
    fetchDimensions.mockRejectedValueOnce(new Error('QuickBooks not connected'));
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual(['MedRock FL: could not verify accounts (QuickBooks fetch failed)']);
  });

  it('collects a warning when a draft line accountName is missing from QuickBooks accounts', async () => {
    const draft = draftFixture('MedRock FL');
    draft.lines.push({
      postingType: 'Debit', amount: 10, accountName: 'Ghost Account', departmentName: null, className: null,
      memo: '', creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
    });
    buildMonthEndAllocation.mockReturnValueOnce([draft]);
    fetchDimensions.mockResolvedValueOnce({ accounts: {}, departments: {}, classes: {} });
    const res = await POST(req({ month: '2026-03' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual(['MedRock FL: account not found: Ghost Account']);
  });
});
