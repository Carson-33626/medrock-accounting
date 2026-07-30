import { describe, it, expect } from 'vitest';
import { jitterMs, Pacer, looksBlocked, DEFAULTS } from './human-pacing';

describe('jitterMs', () => {
  it('spans the range with the RNG, inclusive of both ends', () => {
    expect(jitterMs(1000, 2000, () => 0)).toBe(1000);
    expect(jitterMs(1000, 2000, () => 1)).toBe(2000);
    expect(jitterMs(1000, 2000, () => 0.5)).toBe(1500);
  });

  it('never returns a negative wait, and tolerates a reversed range', () => {
    expect(jitterMs(-500, 100, () => 0)).toBe(0);
    expect(jitterMs(2000, 1000, () => 0)).toBe(1000);
    expect(jitterMs(2000, 1000, () => 1)).toBe(2000);
  });

  it('produces varied values across calls — a constant cadence is the thing being avoided', () => {
    const seq = [0.1, 0.9, 0.42, 0.77, 0.03];
    let i = 0;
    const vals = seq.map(() => jitterMs(1800, 4500, () => seq[i++]));
    expect(new Set(vals).size).toBe(seq.length);
    for (const v of vals) { expect(v).toBeGreaterThanOrEqual(1800); expect(v).toBeLessThanOrEqual(4500); }
  });
});

describe('Pacer', () => {
  it('waits a jittered short interval by default', async () => {
    const slept: number[] = [];
    const p = new Pacer({ rand: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
    const r = await p.wait();
    expect(r.long).toBe(false);
    expect(slept).toEqual([Math.round((DEFAULTS.minMs + DEFAULTS.maxMs) / 2)]);
  });

  it('takes a longer break every Nth call so the run has no steady rhythm', async () => {
    const slept: number[] = [];
    const p = new Pacer({ minMs: 100, maxMs: 100, longEvery: 3, longMinMs: 9000, longMaxMs: 9000, rand: () => 0, sleep: async (ms) => { slept.push(ms); } });
    for (let i = 0; i < 6; i++) await p.wait();
    expect(slept).toEqual([100, 100, 9000, 100, 100, 9000]);
  });

  it('longEvery=0 disables the long break entirely', async () => {
    const slept: number[] = [];
    const p = new Pacer({ minMs: 50, maxMs: 50, longEvery: 0, rand: () => 0, sleep: async (ms) => { slept.push(ms); } });
    for (let i = 0; i < 4; i++) await p.wait();
    expect(slept).toEqual([50, 50, 50, 50]);
  });

  it('counts per instance, so a fresh run restarts the rhythm', () => {
    const mk = (): Pacer => new Pacer({ longEvery: 2, rand: () => 0 });
    const a = mk(); a.next();
    expect(a.next().long).toBe(true);
    expect(mk().next().long).toBe(false);
  });
});

describe('looksBlocked', () => {
  it('detects the challenge pages we must never automate past', () => {
    expect(looksBlocked('Please Press & Hold to confirm you are a human')).toBe(true);
    expect(looksBlocked('We detected unusual activity from your network')).toBe(true);
    expect(looksBlocked('Access Denied')).toBe(true);
    expect(looksBlocked('', 'https://www.samsclub.com/px-captcha')).toBe(true);
  });

  it('does not fire on a normal order page', () => {
    expect(looksBlocked('Purchase history Order 1044 3610 241 Total $247.86')).toBe(false);
    expect(looksBlocked('Member\'s Mark Purified Water', 'https://www.samsclub.com/orders/800000053836344')).toBe(false);
  });
});
