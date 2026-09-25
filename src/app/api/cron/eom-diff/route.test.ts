import { describe, it, expect, vi, beforeEach } from 'vitest';

type RunResult = { skipped: true } | { skipped: false; runId: number; ok: boolean; months: string[] };
const runEomDiff = vi.fn(async (..._a: unknown[]) => ({ skipped: true }) as RunResult);
vi.mock('@/lib/payroll/eom-diff-server', () => ({
  runEomDiff: (...a: unknown[]) => runEomDiff(...a),
}));

import { GET } from './route';
import { NextRequest } from 'next/server';

describe('GET /api/cron/eom-diff', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 's3cret';
    runEomDiff.mockReset();
  });

  it('401 without the bearer secret', async () => {
    expect((await GET(new NextRequest('http://x/api/cron/eom-diff'))).status).toBe(401);
    expect(runEomDiff).not.toHaveBeenCalled();
  });

  it('401 with the wrong bearer secret', async () => {
    const res = await GET(new NextRequest('http://x/api/cron/eom-diff', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
    expect(runEomDiff).not.toHaveBeenCalled();
  });

  it('401 when CRON_SECRET is unset, even with a header', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(new NextRequest('http://x/api/cron/eom-diff', { headers: { authorization: 'Bearer ' } }));
    expect(res.status).toBe(401);
    expect(runEomDiff).not.toHaveBeenCalled();
  });

  it('runs as cron with the right secret', async () => {
    runEomDiff.mockResolvedValueOnce({ skipped: false, runId: 3, ok: true, months: ['2026-03'] });
    const res = await GET(new NextRequest('http://x/api/cron/eom-diff', { headers: { authorization: 'Bearer s3cret' } }));
    expect(res.status).toBe(200);
    expect(runEomDiff).toHaveBeenCalledWith('cron');
    expect(await res.json()).toEqual({ skipped: false, runId: 3, ok: true, months: ['2026-03'] });
  });

  it('500 with the message when the run throws', async () => {
    runEomDiff.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(new NextRequest('http://x/api/cron/eom-diff', { headers: { authorization: 'Bearer s3cret' } }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('db down');
  });
});
