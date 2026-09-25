import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EomDiffSettings } from '@/lib/payroll/eom-correction';

vi.mock('@/lib/auth', () => ({ requireManager: vi.fn(async () => ({ id: 'u1', email: 'd.carson@medrockpharmacy.com' })) }));

const saved: EomDiffSettings = { threshold: 5, enabled: true, checkFromMonth: '2026-03' };
const updateSettings = vi.fn(async (..._a: unknown[]) => saved);
vi.mock('@/lib/payroll/eom-diff-store', () => ({
  updateSettings: (...a: unknown[]) => updateSettings(...a),
}));

import { PUT } from './route';
import { NextRequest } from 'next/server';

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/payroll/eom/diff/settings', { method: 'PUT', body: JSON.stringify(body) });
}

beforeEach(() => {
  updateSettings.mockReset();
  updateSettings.mockResolvedValue(saved);
});

describe('PUT /api/payroll/eom/diff/settings', () => {
  it('400s an invalid threshold and never writes', async () => {
    const res = await PUT(req({ threshold: -1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('threshold');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('saves a valid threshold stamped with the manager\'s email', async () => {
    const res = await PUT(req({ threshold: 5 }));
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ threshold: 5 }, 'd.carson@medrockpharmacy.com');
    expect(await res.json()).toEqual(saved);
  });

  it('500s when the write throws', async () => {
    updateSettings.mockRejectedValueOnce(new Error('db down'));
    const res = await PUT(req({ enabled: false }));
    expect(res.status).toBe(500);
  });
});
