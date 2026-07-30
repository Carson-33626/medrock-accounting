// Human-ish pacing for the CDP scrapers. Bot detection keys on CADENCE as much as on volume: a request
// every 600ms, to the millisecond, is machine-obvious even at low rates. Sam's Club flagged us on
// 2026-07-30 running fixed 400/600ms gaps, so every navigation now waits a randomised interval, with a
// longer "coffee break" every so often to break up the run's rhythm.
//
// Pure except for the clock: `jitterMs` takes an injectable RNG so the distribution is testable.

export interface PacingOpts {
  minMs?: number;
  maxMs?: number;
  /** every Nth call, pause for a longer stretch instead (0 disables) */
  longEvery?: number;
  longMinMs?: number;
  longMaxMs?: number;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULTS = {
  minMs: 1800,
  maxMs: 4500,
  longEvery: 12,
  longMinMs: 8000,
  longMaxMs: 20000,
} as const;

export function jitterMs(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(minMs, maxMs);
  return Math.round(lo + rand() * (hi - lo));
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A counter-carrying pacer, so "every Nth call" is per-run rather than global.
export class Pacer {
  private calls = 0;
  private readonly o: Required<Omit<PacingOpts, 'rand' | 'sleep'>> & { rand: () => number; sleep: (ms: number) => Promise<void> };

  constructor(opts: PacingOpts = {}) {
    this.o = {
      minMs: opts.minMs ?? DEFAULTS.minMs,
      maxMs: opts.maxMs ?? DEFAULTS.maxMs,
      longEvery: opts.longEvery ?? DEFAULTS.longEvery,
      longMinMs: opts.longMinMs ?? DEFAULTS.longMinMs,
      longMaxMs: opts.longMaxMs ?? DEFAULTS.longMaxMs,
      rand: opts.rand ?? Math.random,
      sleep: opts.sleep ?? realSleep,
    };
  }

  /** How long the next wait would be, and whether it is a long break. Advances the counter. */
  next(): { ms: number; long: boolean } {
    this.calls++;
    const long = this.o.longEvery > 0 && this.calls % this.o.longEvery === 0;
    return long
      ? { ms: jitterMs(this.o.longMinMs, this.o.longMaxMs, this.o.rand), long: true }
      : { ms: jitterMs(this.o.minMs, this.o.maxMs, this.o.rand), long: false };
  }

  async wait(): Promise<{ ms: number; long: boolean }> {
    const n = this.next();
    await this.o.sleep(n.ms);
    return n;
  }
}

// Markers that mean the site is challenging us rather than serving data. NEVER try to solve these —
// a human clears the challenge in the real browser, then the run resumes.
const BLOCK_MARKERS = [
  'press & hold',
  'press and hold',
  'verify you are a human',
  'are you a robot',
  'unusual activity',
  'access denied',
  'px-captcha',
  'perimeterx',
  'blocked by',
  'security check',
];

export function looksBlocked(pageText: string, url = ''): boolean {
  const hay = `${pageText} ${url}`.toLowerCase();
  return BLOCK_MARKERS.some((m) => hay.includes(m));
}
