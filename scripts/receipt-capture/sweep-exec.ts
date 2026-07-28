// web/scripts/receipt-capture/sweep-exec.ts
// Child-runner harness: every vendor pipeline runs as its own process with its own gates; one
// crash never stops the sweep. Captures the tail + the runners' summary-line convention.
import { spawn } from 'node:child_process';

export interface ChildResult {
  label: string;
  code: number | null;
  ok: boolean;
  durationMs: number;
  stdoutTail: string;
  summaryLines: string[];
}

const TAIL = 4000;
const SUMMARY_RE = /^\[|MODE:|receipt-gap worklist:|wrote /;

export function runChild(
  label: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; nodeDirect?: boolean } = {},
): Promise<ChildResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    const cmd = opts.nodeDirect ? 'node' : 'npx';
    const full = opts.nodeDirect ? args : ['tsx', ...args];
    const child = spawn(cmd, full, { cwd: opts.cwd });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      if (buf.length > TAIL * 4) buf = buf.slice(-TAIL * 2);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const summaryLines = buf.split(/\r?\n/).filter((l) => SUMMARY_RE.test(l.trim())).map((l) => l.trim());
      resolve({
        label,
        code,
        ok: code === 0,
        durationMs: Date.now() - started,
        stdoutTail: buf.slice(-TAIL),
        summaryLines,
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ label, code: null, ok: false, durationMs: Date.now() - started, stdoutTail: buf.slice(-TAIL), summaryLines: [] });
    });
  });
}
