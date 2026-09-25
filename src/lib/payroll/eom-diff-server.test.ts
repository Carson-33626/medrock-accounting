import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EomDiffSettings } from './eom-correction';
import type { EomTargetResult } from './eom-target';
import type { PayrollHeader } from './store';
import type { Entity, JournalDraft, JournalLine } from './types';
import type { Month } from './month';
import type { EomDiffRun, EomDiffCheck } from './eom-diff-store';

const getSettings = vi.fn(async (..._a: unknown[]) => ({ threshold: 1, enabled: true, checkFromMonth: '2026-03' }) as EomDiffSettings);
const startRun = vi.fn(async (..._a: unknown[]) => 1);
const finishRun = vi.fn(async (..._a: unknown[]) => undefined);
const latestRun = vi.fn(async (..._a: unknown[]) => null as EomDiffRun | null);
const upsertCheck = vi.fn(async (..._a: unknown[]) => undefined);
const deleteCheck = vi.fn(async (..._a: unknown[]) => undefined);
const deleteChecksNotIn = vi.fn(async (..._a: unknown[]) => undefined);
const listChecks = vi.fn(async (..._a: unknown[]) => [] as EomDiffCheck[]);
const listPostedParentMonths = vi.fn(async (..._a: unknown[]) => [] as string[]);
// Typed (not `unknown[]`) because tests below need mockImplementation((m: Month, e: Entity) => …).
const listPostedEomHeaderIds = vi.fn(async (_m: Month, _e: Entity) => [] as number[]);
vi.mock('./eom-diff-store', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  startRun: (...a: unknown[]) => startRun(...a),
  finishRun: (...a: unknown[]) => finishRun(...a),
  latestRun: (...a: unknown[]) => latestRun(...a),
  upsertCheck: (...a: unknown[]) => upsertCheck(...a),
  deleteCheck: (...a: unknown[]) => deleteCheck(...a),
  deleteChecksNotIn: (...a: unknown[]) => deleteChecksNotIn(...a),
  listChecks: (...a: unknown[]) => listChecks(...a),
  listPostedParentMonths: (...a: unknown[]) => listPostedParentMonths(...a),
  listPostedEomHeaderIds: (m: Month, e: Entity) => listPostedEomHeaderIds(m, e),
}));

const computeEomTarget = vi.fn(async (..._a: unknown[]) => targetWith({}));
vi.mock('./eom-target', () => ({
  computeEomTarget: (...a: unknown[]) => computeEomTarget(...a),
}));

// Typed (not `unknown[]`) because a test below needs mockImplementation((id: number) => …).
const loadDraft = vi.fn(async (_id: number) => null as { header: PayrollHeader; lines: JournalLine[] } | null);
vi.mock('./store', () => ({
  loadDraft: (id: number) => loadDraft(id),
}));

import { runEomDiff, buildEomDiffStatus } from './eom-diff-server';

const L = (postingType: 'Debit' | 'Credit', amount: number, accountName: string, memo = 'm'): JournalLine => ({
  postingType, amount, accountName, departmentName: null, className: null, memo, creditBucket: null, origin: 'inter_entity', sourceRowKeys: [],
});

function draft(entity: Entity, lines: JournalLine[]): JournalDraft {
  return {
    entity, payDate: '03/31/2026', payGroup: 'EOM', periodStart: '2026-01-01', periodEnd: '2026-03-31',
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

function hdr(id: number): PayrollHeader {
  return {
    id, entity: 'MedRock FL', pay_date: '03/31/2026', pay_group: 'EOM', period_start: '2026-01-01', period_end: '2026-03-31',
    status: 'posted', total_debits: 0, total_credits: 0, variance: 0, row_count: 0, source_snapshot_hash: null,
    qb_entry_id: 'qb-1', qb_doc_number: 'FL % Allo 2026.03', kind: 'allocation', period_segment: '', txn_date: '2026-03-31', piece_count: 1,
  };
}

function chk(month: string, entity: Entity, deltaDebits: number): EomDiffCheck {
  return { month, entity, runId: 1, checkedAt: '2026-09-25T00:00:00Z', deltaLines: [], deltaDebits, error: null };
}

beforeEach(() => {
  getSettings.mockReset();
  startRun.mockReset();
  finishRun.mockReset();
  latestRun.mockReset();
  upsertCheck.mockReset();
  deleteCheck.mockReset();
  deleteChecksNotIn.mockReset();
  listChecks.mockReset();
  listPostedParentMonths.mockReset();
  listPostedEomHeaderIds.mockReset();
  computeEomTarget.mockReset();
  loadDraft.mockReset();

  getSettings.mockResolvedValue({ threshold: 1, enabled: true, checkFromMonth: '2026-03' });
  startRun.mockResolvedValue(1);
  finishRun.mockResolvedValue(undefined);
  latestRun.mockResolvedValue(null);
  upsertCheck.mockResolvedValue(undefined);
  deleteCheck.mockResolvedValue(undefined);
  deleteChecksNotIn.mockResolvedValue(undefined);
  listChecks.mockResolvedValue([]);
  listPostedParentMonths.mockResolvedValue([]);
  listPostedEomHeaderIds.mockResolvedValue([]);
  computeEomTarget.mockResolvedValue(targetWith({}));
  loadDraft.mockResolvedValue(null);
});

describe('runEomDiff', () => {
  it('skips a cron run when disabled, but never a manual run', async () => {
    getSettings.mockResolvedValue({ threshold: 1, enabled: false, checkFromMonth: '2026-03' });
    expect(await runEomDiff('cron')).toEqual({ skipped: true });
    listPostedParentMonths.mockResolvedValueOnce([]);
    expect((await runEomDiff('manual')).skipped).toBe(false);
  });

  it('stores the delta per entity: target minus posted parent + corrections', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce(targetWith({ 'MedRock FL': [L('Debit', 110, 'Wages'), L('Credit', 110, 'Due to TN')] }));
    listPostedEomHeaderIds.mockImplementation(async (_m: Month, e: Entity) => (e === 'MedRock FL' ? [1, 2] : []));
    loadDraft.mockImplementation(async (id: number) => ({ header: hdr(id), lines: id === 1 ? [L('Debit', 100, 'Wages'), L('Credit', 100, 'Due to TN')] : [L('Debit', 5, 'Wages'), L('Credit', 5, 'Due to TN')] }));
    await runEomDiff('manual');
    const fl = upsertCheck.mock.calls.map((c) => c[0] as { entity: Entity; deltaDebits: number; deltaLines: JournalLine[] }).find((c) => c.entity === 'MedRock FL');
    expect(fl?.deltaDebits).toBe(5);
    expect(fl?.deltaLines).toEqual([L('Debit', 5, 'Wages'), L('Credit', 5, 'Due to TN')]);
  });

  it('target missing for an entity fully reverses its posted lines', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce(targetWith({}));
    listPostedEomHeaderIds.mockImplementation(async (_m: Month, e: Entity) => (e === 'MedRock TX' ? [9] : []));
    loadDraft.mockResolvedValue({ header: hdr(9), lines: [L('Debit', 40, 'Wages'), L('Credit', 40, 'Due to FL')] });
    await runEomDiff('manual');
    const tx = upsertCheck.mock.calls.map((c) => c[0] as { entity: Entity; deltaDebits: number }).find((c) => c.entity === 'MedRock TX');
    expect(tx?.deltaDebits).toBe(40);
  });

  it('a QuickBooks failure stores the error per entity and finishes the run not-ok', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce({ ok: false, status: 502, error: 'QuickBooks disconnected: MedRock TN' });
    const r = await runEomDiff('manual');
    expect(r).toMatchObject({ skipped: false, ok: false });
    expect(upsertCheck.mock.calls.every((c) => (c[0] as { error: string | null }).error === 'QuickBooks disconnected: MedRock TN')).toBe(true);
    expect(finishRun).toHaveBeenCalledWith(expect.any(Number), false, '2026-03: QuickBooks disconnected: MedRock TN');
  });

  it('a posted header that cannot be loaded records an error row for that month/entity; the run continues (deferred d)', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce(targetWith({ 'MedRock FL': [L('Debit', 10, 'Wages'), L('Credit', 10, 'Due to TN')] }));
    listPostedEomHeaderIds.mockImplementation(async (_m: Month, e: Entity) => (e === 'MedRock FL' ? [1] : e === 'MedRock TN' ? [2] : []));
    loadDraft.mockImplementation(async (id: number) => (id === 1 ? null : { header: hdr(id), lines: [L('Debit', 5, 'Wages'), L('Credit', 5, 'Due to FL')] }));
    const r = await runEomDiff('manual');
    const calls = upsertCheck.mock.calls.map((c) => c[0] as { entity: Entity; error: string | null; deltaDebits: number });
    expect(calls.find((c) => c.entity === 'MedRock FL')?.error).toContain('#1');
    expect(calls.find((c) => c.entity === 'MedRock TN')).toMatchObject({ error: null, deltaDebits: 5 });
    expect(r).toMatchObject({ skipped: false, ok: false });
  });

  it('a posted header with zero lines is an error row, not a silent skip (deferred d)', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce(targetWith({}));
    listPostedEomHeaderIds.mockImplementation(async (_m: Month, e: Entity) => (e === 'MedRock FL' ? [1] : []));
    loadDraft.mockResolvedValue({ header: hdr(1), lines: [] });
    await runEomDiff('manual');
    const fl = upsertCheck.mock.calls.map((c) => c[0] as { entity: Entity; error: string | null }).find((c) => c.entity === 'MedRock FL');
    expect(fl?.error).toContain('no stored lines');
  });

  it('clears the check row of an entity with no posted set, and rows for months outside the run (I4)', async () => {
    listPostedParentMonths.mockResolvedValueOnce(['2026-03']);
    computeEomTarget.mockResolvedValueOnce(targetWith({}));
    listPostedEomHeaderIds.mockImplementation(async (_m: Month, e: Entity) => (e === 'MedRock FL' ? [1] : []));
    loadDraft.mockResolvedValue({ header: hdr(1), lines: [L('Debit', 5, 'Wages'), L('Credit', 5, 'Due to TN')] });
    await runEomDiff('manual');
    expect(deleteCheck).toHaveBeenCalledWith('2026-03', 'MedRock TN');
    expect(deleteCheck).toHaveBeenCalledWith('2026-03', 'MedRock TX');
    expect(deleteCheck).not.toHaveBeenCalledWith('2026-03', 'MedRock FL');
    expect(deleteChecksNotIn).toHaveBeenCalledWith(['2026-03']);
  });

  it('a thrown error mid-run still finishes the run', async () => {
    listPostedParentMonths.mockRejectedValueOnce(new Error('db down'));
    await expect(runEomDiff('manual')).rejects.toThrow('db down');
    expect(finishRun).toHaveBeenCalledWith(expect.any(Number), false, 'db down');
  });
});

describe('buildEomDiffStatus', () => {
  it('flags at read time against the CURRENT threshold, oldest month first', () => {
    const checks = [chk('2026-04', 'MedRock FL', 3), chk('2026-03', 'MedRock TN', 0.5), chk('2026-03', 'MedRock FL', 2)];
    const s = buildEomDiffStatus({ threshold: 1, enabled: true, checkFromMonth: '2026-03' }, null, checks);
    expect(s.flagged).toEqual([
      { month: '2026-03', entities: [{ entity: 'MedRock FL', deltaDebits: 2 }] },
      { month: '2026-04', entities: [{ entity: 'MedRock FL', deltaDebits: 3 }] },
    ]);
    expect(buildEomDiffStatus({ threshold: 5, enabled: true, checkFromMonth: '2026-03' }, null, checks).flagged).toEqual([]);
  });

  it('an unfinished run older than 10 minutes counts as failed (timed out)', () => {
    const settings = { threshold: 1, enabled: true, checkFromMonth: '2026-03' };
    const run: EomDiffRun = { id: 1, trigger: 'cron', startedAt: '2026-09-25T10:00:00Z', finishedAt: null, ok: null, error: null };
    const now = Date.parse('2026-09-25T10:11:00Z');
    expect(buildEomDiffStatus(settings, run, [], now).lastRun).toMatchObject({ ok: false, error: 'check did not finish (timed out)' });
    const recent = Date.parse('2026-09-25T10:05:00Z');
    expect(buildEomDiffStatus(settings, run, [], recent).lastRun).toEqual(run);
  });

  it('a check row with an error is never flagged', () => {
    const s = buildEomDiffStatus({ threshold: 1, enabled: true, checkFromMonth: '2026-03' }, null, [{ ...chk('2026-03', 'MedRock FL', 9), error: 'x' }]);
    expect(s.flagged).toEqual([]);
  });
});
