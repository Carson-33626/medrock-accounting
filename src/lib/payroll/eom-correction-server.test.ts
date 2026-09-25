import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EomTargetResult } from './eom-target';
import type { PayrollHeader } from './store';
import type { Entity, JournalDraft, JournalLine } from './types';
import type { EomEntity } from './revenue-rule';

const computeEomTarget = vi.fn(async (..._a: unknown[]) => targetWith({}));
vi.mock('./eom-target', () => ({
  computeEomTarget: (...a: unknown[]) => computeEomTarget(...a),
}));

const listEomHeaders = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
const listEomCorrectionHeaders = vi.fn(async (..._a: unknown[]) => [] as PayrollHeader[]);
vi.mock('./eom-store', () => ({
  listEomHeaders: (...a: unknown[]) => listEomHeaders(...a),
  listEomCorrectionHeaders: (...a: unknown[]) => listEomCorrectionHeaders(...a),
}));

const saveDraft = vi.fn(async (..._a: unknown[]) => 1);
const insertAudit = vi.fn(async (..._a: unknown[]) => undefined);
const loadDraft = vi.fn(async (_id: number) => null as { header: PayrollHeader; lines: JournalLine[] } | null);
vi.mock('./store', () => ({
  saveDraft: (...a: unknown[]) => saveDraft(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
  loadDraft: (id: number) => loadDraft(id),
}));

const fetchDimensions = vi.fn(async (..._a: unknown[]) => ({ accounts: {}, departments: {}, classes: {} }));
vi.mock('./qb-journal', () => ({
  fetchDimensions: (...a: unknown[]) => fetchDimensions(...a),
}));

const query = vi.fn(async (..._a: unknown[]) => ({ rows: [], rowCount: 0 }));
vi.mock('../rds', () => ({
  getRdsPool: () => ({ query: (...a: unknown[]) => query(...a) }),
}));

import { generateEomCorrection } from './eom-correction-server';

const L = (postingType: 'Debit' | 'Credit', amount: number, accountName: string, memo = 'm'): JournalLine => ({
  postingType, amount, accountName, departmentName: null, className: null, memo, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
});

const PARENT_LINES: JournalLine[] = [L('Debit', 100, 'Wages'), L('Credit', 100, 'Due to TN')];

function draft(entity: Entity, lines: JournalLine[]): JournalDraft {
  return {
    entity, payDate: '03/31/2026', payGroup: 'EOM', periodStart: '2026-03-01', periodEnd: '2026-03-31',
    lines, totalDebits: 0, totalCredits: 0, variance: 0, rowKeys: [],
  };
}

function targetWith(byEntity: Partial<Record<Entity, JournalLine[]>>): EomTargetResult {
  return {
    ok: true,
    drafts: (Object.keys(byEntity) as Entity[]).map((e) => draft(e, byEntity[e] ?? [])),
    pool: [],
    attention: [],
    revenueTest: { month: '2026-03', income: { 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 } },
    shares: { 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 },
    csAlloDocs: [],
    csExcludedCount: 0,
  };
}

function hdr(id: number, entity: EomEntity): PayrollHeader {
  return {
    id, entity, pay_date: '03/31/2026', pay_group: 'EOM', period_start: '2026-03-01', period_end: '2026-03-31',
    status: 'posted', total_debits: 0, total_credits: 0, variance: 0, row_count: 0, source_snapshot_hash: null,
    qb_entry_id: 'qb-1', qb_doc_number: 'FL % Allo 2026.03', kind: 'allocation', period_segment: '', txn_date: '2026-03-31', piece_count: 1,
  };
}

beforeEach(() => {
  computeEomTarget.mockReset();
  listEomHeaders.mockReset();
  listEomCorrectionHeaders.mockReset();
  saveDraft.mockReset();
  insertAudit.mockReset();
  loadDraft.mockReset();
  fetchDimensions.mockReset();
  query.mockReset();

  computeEomTarget.mockResolvedValue(targetWith({}));
  listEomHeaders.mockResolvedValue([]);
  listEomCorrectionHeaders.mockResolvedValue([]);
  saveDraft.mockResolvedValue(1);
  insertAudit.mockResolvedValue(undefined);
  loadDraft.mockResolvedValue(null);
  fetchDimensions.mockResolvedValue({ accounts: {}, departments: {}, classes: {} });
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('generateEomCorrection', () => {
  it('409 when the month has no posted parent for the entity', async () => {
    listEomHeaders.mockResolvedValueOnce([{ ...hdr(1, 'MedRock FL'), status: 'approved' }]);
    expect(await generateEomCorrection('2026-03', 'MedRock FL', '2026-09-26')).toMatchObject({ status: 409 });
  });

  it('nothingToCorrect when target equals posted; deletes a stale open correction', async () => {
    listEomHeaders.mockResolvedValueOnce([hdr(1, 'MedRock FL')]);
    listEomCorrectionHeaders.mockResolvedValueOnce([{ ...hdr(7, 'MedRock FL'), status: 'needs_review', period_segment: 'C1' }]);
    computeEomTarget.mockResolvedValueOnce(targetWith({ 'MedRock FL': PARENT_LINES }));
    loadDraft.mockResolvedValue({ header: hdr(1, 'MedRock FL'), lines: PARENT_LINES });
    expect(await generateEomCorrection('2026-03', 'MedRock FL', '2026-09-26')).toEqual({ nothingToCorrect: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM accounting.payroll_journal_headers'), [7]);
  });

  it('saves C1 as "<doc>-2" with only the delta lines, audited generated', async () => {
    listEomHeaders.mockResolvedValueOnce([hdr(1, 'MedRock FL')]);
    listEomCorrectionHeaders.mockResolvedValueOnce([]);
    computeEomTarget.mockResolvedValueOnce(targetWith({ 'MedRock FL': [L('Debit', 110, 'Wages'), L('Credit', 110, 'Due to TN')] }));
    loadDraft.mockResolvedValue({ header: hdr(1, 'MedRock FL'), lines: [L('Debit', 100, 'Wages'), L('Credit', 100, 'Due to TN')] });
    const r = await generateEomCorrection('2026-03', 'MedRock FL', '2026-09-26');
    expect(r).toMatchObject({ docNumber: 'FL % Allo 2026.03-2' });
    const draft = saveDraft.mock.calls[0][0] as JournalDraft;
    expect(draft.periodSegment).toBe('C1');
    expect(draft.payGroup).toBe('EOM');
    expect(draft.lines).toEqual([L('Debit', 10, 'Wages', 'm'), L('Credit', 10, 'Due to TN', 'm')]);
    expect(draft.totalDebits).toBe(10);
    expect(insertAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'generated' }));
  });

  it('after a posted C1 the next correction is C2 "-3", netting C1 too', async () => {
    listEomHeaders.mockResolvedValueOnce([hdr(1, 'MedRock FL')]);
    listEomCorrectionHeaders.mockResolvedValueOnce([{ ...hdr(5, 'MedRock FL'), period_segment: 'C1' }]);
    computeEomTarget.mockResolvedValueOnce(targetWith({ 'MedRock FL': [L('Debit', 120, 'Wages'), L('Credit', 120, 'Due to TN')] }));
    loadDraft.mockImplementation(async (id: number) => ({ header: hdr(id, 'MedRock FL'), lines: id === 1 ? [L('Debit', 100, 'Wages'), L('Credit', 100, 'Due to TN')] : [L('Debit', 10, 'Wages'), L('Credit', 10, 'Due to TN')] }));
    const r = await generateEomCorrection('2026-03', 'MedRock FL', '2026-09-26');
    expect(r).toMatchObject({ docNumber: 'FL % Allo 2026.03-3' });
    expect((saveDraft.mock.calls[0][0] as JournalDraft).lines[0].amount).toBe(10);
  });

  it('passes a QuickBooks failure through with its status', async () => {
    listEomHeaders.mockResolvedValueOnce([hdr(1, 'MedRock FL')]);
    listEomCorrectionHeaders.mockResolvedValueOnce([]);
    computeEomTarget.mockResolvedValueOnce({ ok: false, status: 502, error: 'QB down' });
    expect(await generateEomCorrection('2026-03', 'MedRock FL', '2026-09-26')).toEqual({ locked: 'QB down', status: 502 });
  });
});
