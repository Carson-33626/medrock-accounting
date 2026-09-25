import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EomDiffStatus } from '@/lib/payroll/eom-diff-server';

vi.mock('@/lib/auth', () => ({ requireManager: vi.fn(async () => ({ id: 'u1', email: 'd.carson@medrockpharmacy.com' })) }));

type RunResult = { skipped: true } | { skipped: false; runId: number; ok: boolean; months: string[] };
const status: EomDiffStatus = {
  settings: { threshold: 1, enabled: true, checkFromMonth: '2026-03' },
  lastRun: null,
  checks: [],
  flagged: [],
};
const runEomDiff = vi.fn(async (..._a: unknown[]) => ({ skipped: true }) as RunResult);
const getEomDiffStatus = vi.fn(async (..._a: unknown[]) => status);
vi.mock('@/lib/payroll/eom-diff-server', () => ({
  runEomDiff: (...a: unknown[]) => runEomDiff(...a),
  getEomDiffStatus: (...a: unknown[]) => getEomDiffStatus(...a),
}));

import { GET, POST } from './route';

beforeEach(() => {
  runEomDiff.mockReset();
  getEomDiffStatus.mockReset();
  getEomDiffStatus.mockResolvedValue(status);
});

describe('GET /api/payroll/eom/diff', () => {
  it('returns the status', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it('500s when the status read throws', async () => {
    getEomDiffStatus.mockRejectedValueOnce(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('db down');
  });
});

describe('POST /api/payroll/eom/diff', () => {
  it('runs a manual check and returns the run + fresh status', async () => {
    const run: RunResult = { skipped: false, runId: 7, ok: true, months: ['2026-04'] };
    runEomDiff.mockResolvedValueOnce(run);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(runEomDiff).toHaveBeenCalledWith('manual');
    expect(await res.json()).toEqual({ run, status });
  });

  it('500s when the run throws', async () => {
    runEomDiff.mockRejectedValueOnce(new Error('boom'));
    const res = await POST();
    expect(res.status).toBe(500);
  });
});
