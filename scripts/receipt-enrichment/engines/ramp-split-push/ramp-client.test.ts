import { describe, it, expect } from 'vitest';
import { rampFetch, type FetchLike } from './ramp-client';

const noSleep = (): Promise<void> => Promise.resolve();
const res = (status: number): Response => new Response('{}', { status });

describe('rampFetch retry', () => {
  it('retries a thrown network error and returns the eventual success', async () => {
    // The 2026-07-30 failure mode: undici ConnectTimeoutError THROWS, so status-based retry loops
    // downstream never fired and one blip killed a whole live sweep mid-run.
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      return res(200);
    };
    const r = await rampFetch('https://x/y', {}, { fetchImpl, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('throws with the last error once attempts are exhausted', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; throw new Error('fetch failed'); };
    await expect(rampFetch('https://x/y', {}, { fetchImpl, sleep: noSleep, attempts: 3 }))
      .rejects.toThrow(/failed after 3 attempts/);
    expect(calls).toBe(3);
  });

  it('retries transient statuses (429, 500, 408) but not the caller-meaningful ones', async () => {
    for (const status of [408, 429, 500, 503]) {
      let calls = 0;
      const fetchImpl: FetchLike = async () => { calls++; return res(calls < 2 ? status : 200); };
      const r = await rampFetch('https://x/y', {}, { fetchImpl, sleep: noSleep });
      expect(r.status, `status ${status} should be retried`).toBe(200);
      expect(calls, `status ${status} should be retried`).toBe(2);
    }
  });

  it('returns 4xx immediately — a 404/400 is an answer, not a blip', async () => {
    for (const status of [400, 401, 404, 422]) {
      let calls = 0;
      const fetchImpl: FetchLike = async () => { calls++; return res(status); };
      const r = await rampFetch('https://x/y', {}, { fetchImpl, sleep: noSleep });
      expect(r.status).toBe(status);
      expect(calls, `status ${status} must not burn retries`).toBe(1);
    }
  });

  it('returns the final retriable response instead of throwing when the budget runs out', async () => {
    // A persistent 500 must surface to the caller as a 500 it can log, not as an exception.
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; return res(500); };
    const r = await rampFetch('https://x/y', {}, { fetchImpl, sleep: noSleep, attempts: 3 });
    expect(r.status).toBe(500);
    expect(calls).toBe(3);
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; if (calls < 4) throw new Error('boom'); return res(200); };
    await rampFetch('https://x/y', {}, { fetchImpl, sleep: async (ms) => { delays.push(ms); } });
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});
