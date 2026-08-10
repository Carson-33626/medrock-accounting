import { describe, it, expect, vi } from 'vitest';
import { LOCATION_MAPPING, qbQueryAll } from './quickbooks';
import type { QbTokens } from './quickbooks';

const TOKENS: QbTokens = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: Date.now() + 60 * 60 * 1000,
  realm_id: 'realm-1',
  location: 'MedRock FL',
};

function pageOf(n: number): { Id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ Id: String(i) }));
}

describe('LOCATION_MAPPING', () => {
  it('carries all four QB companies, FOCAS included', () => {
    expect(Object.keys(LOCATION_MAPPING).sort()).toEqual(
      ['FOCAS', 'MedRock FL', 'MedRock TN', 'MedRock TX'],
    );
  });
});

describe('qbQueryAll', () => {
  it('paginates via STARTPOSITION until a short page', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string): Promise<Response> => {
      urls.push(url);
      const n = urls.length === 1 ? 1000 : 3;
      return new Response(JSON.stringify({ QueryResponse: { Bill: pageOf(n) } }), { status: 200 });
    });

    const out = await qbQueryAll<{ Id: string }>('MedRock FL', 'Bill', "WHERE Id = '1'", {
      fetchImpl,
      getTokens: async () => TOKENS,
    });

    expect(out).toHaveLength(1003);
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[0])).toContain('STARTPOSITION 1');
    expect(decodeURIComponent(urls[1])).toContain('STARTPOSITION 1001');
  });

  it('returns an empty array when the entity key is absent', async () => {
    const out = await qbQueryAll<{ Id: string }>('MedRock TN', 'Bill', '', {
      fetchImpl: async () => new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 }),
      getTokens: async () => TOKENS,
    });
    expect(out).toEqual([]);
  });

  it('retries a 429 with backoff and then succeeds', async () => {
    const slept: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify({ QueryResponse: { Bill: pageOf(2) } }), { status: 200 });
    });

    const out = await qbQueryAll<{ Id: string }>('MedRock TX', 'Bill', '', {
      fetchImpl,
      getTokens: async () => TOKENS,
      sleep: async (ms: number) => { slept.push(ms); },
    });

    expect(out).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it('throws a named error when the location has no stored connection', async () => {
    await expect(
      qbQueryAll<{ Id: string }>('FOCAS', 'Bill', '', {
        fetchImpl: async () => new Response('{}', { status: 200 }),
        getTokens: async () => null,
      }),
    ).rejects.toThrow('QuickBooks not connected for location: FOCAS');
  });

  it('surfaces a non-429 API error with status and body', async () => {
    await expect(
      qbQueryAll<{ Id: string }>('MedRock FL', 'Bill', '', {
        fetchImpl: async () => new Response('bad query', { status: 400 }),
        getTokens: async () => TOKENS,
      }),
    ).rejects.toThrow('QB API error for MedRock FL: 400 bad query');
  });
});
