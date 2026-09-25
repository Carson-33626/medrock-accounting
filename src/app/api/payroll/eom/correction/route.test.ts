import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ requireManager: vi.fn(async () => ({ id: 'u1', email: 'd.carson@medrockpharmacy.com' })) }));

type GenResult =
  | { headerId: number; docNumber: string; warnings: string[] }
  | { nothingToCorrect: true }
  | { locked: string; status: 409 | 422 | 502 };
const generateEomCorrection = vi.fn(async (..._a: unknown[]) => ({ nothingToCorrect: true }) as GenResult);
vi.mock('@/lib/payroll/eom-correction-server', () => ({
  generateEomCorrection: (...a: unknown[]) => generateEomCorrection(...a),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/payroll/eom/correction', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  generateEomCorrection.mockReset();
});

describe('POST /api/payroll/eom/correction', () => {
  it('400s a bad month', async () => {
    const res = await POST(req({ month: '2026-3', entity: 'MedRock FL' }));
    expect(res.status).toBe(400);
    expect(generateEomCorrection).not.toHaveBeenCalled();
  });

  it('400s an entity outside the month-end entities', async () => {
    const res = await POST(req({ month: '2026-03', entity: 'MedRock XX' }));
    expect(res.status).toBe(400);
    expect(generateEomCorrection).not.toHaveBeenCalled();
  });

  it('maps a locked outcome to its status', async () => {
    generateEomCorrection.mockResolvedValueOnce({ locked: 'MedRock FL: no posted 2026-03 month-end allocation to correct', status: 409 });
    const res = await POST(req({ month: '2026-03', entity: 'MedRock FL' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no posted 2026-03');
  });

  it('returns nothingToCorrect as 200', async () => {
    generateEomCorrection.mockResolvedValueOnce({ nothingToCorrect: true });
    const res = await POST(req({ month: '2026-03', entity: 'MedRock FL' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nothingToCorrect: true });
  });

  it('generates with today\'s date and returns the draft', async () => {
    generateEomCorrection.mockResolvedValueOnce({ headerId: 42, docNumber: 'FL % Allo 2026.03-2', warnings: [] });
    const res = await POST(req({ month: '2026-03', entity: 'MedRock FL' }));
    expect(res.status).toBe(200);
    expect(generateEomCorrection).toHaveBeenCalledWith('2026-03', 'MedRock FL', new Date().toISOString().slice(0, 10));
    expect(await res.json()).toEqual({ headerId: 42, docNumber: 'FL % Allo 2026.03-2', warnings: [] });
  });

  it('500s when generation throws', async () => {
    generateEomCorrection.mockRejectedValueOnce(new Error('qb down'));
    const res = await POST(req({ month: '2026-03', entity: 'MedRock FL' }));
    expect(res.status).toBe(500);
  });
});
