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
});
