// web/scripts/receipt-capture/sweep-exec.ts
// Child-runner harness: every vendor pipeline runs as its own process with its own gates; one
// crash never stops the sweep. Captures the tail + the runners' summary-line convention.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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

// Resolve tsx CLI path at module load time; if resolution fails, hold the error for later.
let tsxPath: string | null = null;
let tsxResolveError: Error | null = null;
try {
  const require = createRequire(import.meta.url);
  tsxPath = require.resolve('tsx/cli');
} catch (err) {
  tsxResolveError = err as Error;
}

export function runChild(
  label: string,
  args: string[],
  // onData is additive (Task 2, sweep-ui-server.ts): a tap for the child's combined stdout+stderr
  // as it arrives, used to feed the control panel's SSE stream. Default unused -- callers who
  // don't pass it see no behavior change.
  opts: { timeoutMs?: number; cwd?: string; nodeDirect?: boolean; onData?: (chunk: string) => void } = {},
): Promise<ChildResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    // If tsx resolution failed and we're not using nodeDirect, return immediately with error.
    if (!opts.nodeDirect && !tsxPath && tsxResolveError) {
      return resolve({
        label,
        code: null,
        ok: false,
        durationMs: Date.now() - started,
        stdoutTail: `tsx not found: ${tsxResolveError.message}`,
        summaryLines: [],
      });
    }

    const spawnArgs = opts.nodeDirect ? args : [tsxPath as string, ...args];
    const child = spawn(process.execPath, spawnArgs, { cwd: opts.cwd });
    let buf = '';
    const handleChunk = (d: Buffer): void => {
      const chunk = d.toString();
      buf += chunk;
      if (buf.length > TAIL * 4) buf = buf.slice(-TAIL * 2);
      opts.onData?.(chunk);
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
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
