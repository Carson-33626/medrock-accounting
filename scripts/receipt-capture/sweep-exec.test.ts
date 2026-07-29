// web/scripts/receipt-capture/sweep-exec.test.ts
import { describe, it, expect } from 'vitest';
import { runChild } from './sweep-exec';

describe('runChild', () => {
  it('captures exit code and summary lines', async () => {
    const r = await runChild('ok-child', ['--eval', 'console.log("[FL] did 3 things"); console.log("noise")'], { timeoutMs: 30000, nodeDirect: true });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.summaryLines).toEqual(['[FL] did 3 things']);
  }, 40000);
  it('reports failure without throwing', async () => {
    const r = await runChild('bad-child', ['--eval', 'process.exit(3)'], { timeoutMs: 30000, nodeDirect: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
  }, 40000);
  it('spawns production path (tsx) and captures output', async () => {
    const r = await runChild('fixture', ['scripts/receipt-capture/fixtures/sweep-exec-fixture.ts'], { timeoutMs: 60000 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.summaryLines).toContain('[FX] fixture ran');
  }, 70000);
  it('taps combined stdout+stderr via onData as chunks arrive, without changing the resolved result', async () => {
    const chunks: string[] = [];
    const r = await runChild(
      'tap-child',
      ['--eval', 'console.log("hello"); console.error("world")'],
      { timeoutMs: 30000, nodeDirect: true, onData: (c) => chunks.push(c) },
    );
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(chunks.join('')).toContain('hello');
    expect(chunks.join('')).toContain('world');
  }, 40000);
  it('onData is optional -- omitting it changes nothing', async () => {
    const r = await runChild('no-tap-child', ['--eval', 'console.log("[FL] did 1 thing")'], { timeoutMs: 30000, nodeDirect: true });
    expect(r.ok).toBe(true);
    expect(r.summaryLines).toEqual(['[FL] did 1 thing']);
  }, 40000);
});
