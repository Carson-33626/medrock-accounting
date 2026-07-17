import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => undefined) }));
const save = vi.fn(async () => undefined);
const list = vi.fn(async () => []);
vi.mock('@/lib/payroll/store', () => ({
  getAllocationRules: (...a: unknown[]) => list(...a),
  saveAllocationRuleSet: (...a: unknown[]) => save(...a),
  setAllocationRuleActive: vi.fn(async () => undefined),
}));

import { GET, POST } from './route';
import { NextRequest } from 'next/server';

beforeEach(() => { save.mockClear(); list.mockClear(); });

describe('allocation-rules route', () => {
  it('GET returns the rules for a cost center', async () => {
    const res = await GET(new NextRequest('http://x/api/payroll/allocation-rules?costCenter=ADMIN'));
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith('ADMIN');
  });
  it('POST rejects a set that does not sum to 100 (store throws → 400)', async () => {
    save.mockRejectedValueOnce(new Error('allocation percents must sum to 100, got 99.9999'));
    const res = await POST(new NextRequest('http://x/api/payroll/allocation-rules', {
      method: 'POST',
      body: JSON.stringify({ costCenter: 'ADMIN', effectiveFrom: '2026-08-01', rules: [{ costCenter: 'ADMIN', targetEntity: 'MedRock FL', percent: 33, effectiveFrom: '2026-08-01', active: true }] }),
    }));
    expect(res.status).toBe(400);
  });
  it('POST saves a valid set', async () => {
    const res = await POST(new NextRequest('http://x/api/payroll/allocation-rules', {
      method: 'POST',
      body: JSON.stringify({ costCenter: 'ADMIN', effectiveFrom: '2026-08-01', rules: [{ costCenter: 'ADMIN', targetEntity: 'MedRock FL', percent: 33.3333, effectiveFrom: '2026-08-01', active: true }] }),
    }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
  });
});
