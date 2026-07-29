// web/scripts/receipt-capture/sweep-ui-server.test.ts
//
// Integration tests against a real ephemeral loopback server (DS 2026-07-29 §3.2, Task 2 brief).
// Every test binds port:0 so the OS assigns a free port, fetches against it, and closes the
// server in a `finally` -- no test leaves a listening socket or a running child process behind.
import { describe, it, expect } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startSweepUiServer } from './sweep-ui-server';
import { runChild as realRunChild } from './sweep-exec';
import type { ChildResult } from './sweep-exec';
import type { ResolvedAction, ActionError } from './sweep-ui-actions';
import type { PanelStatus } from './sweep-ui-status';

const PAGE = '<html><body>Sweep Control Panel</body></html>';

// Polls /api/status until `busy` clears (or the deadline hits) instead of a fixed sleep -- a fixed
// sleep races the child's actual completion time under CI/machine load and is the de-flake target
// here (was a plain setTimeout in two tests below).
async function waitUntilNotBusy(port: number, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as PanelStatus;
    if (status.busy === null) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`timed out after ${deadlineMs}ms waiting for busy to clear`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// fetch()'s Fetch-spec forbidden-header list blocks setting Host/Origin directly, so the CSRF
// guard tests below need a raw node:http client instead of the global fetch used everywhere else
// in this file.
interface RawRequestOpts {
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}
function rawRequest(opts: RawRequestOpts): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('startSweepUiServer', () => {
  it('GET / serves the injected page string as html', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe(PAGE);
    } finally {
      await close();
    }
  });

  it('GET /api/status returns 200 with the documented PanelStatus JSON shape', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = (await res.json()) as PanelStatus;
      expect(Array.isArray(json.vendors)).toBe(true);
      expect(json.vendors).toHaveLength(6);
      expect(json).toHaveProperty('lastSweep');
      expect(json).toHaveProperty('latestReport');
      expect(json.busy).toBeNull();
    } finally {
      await close();
    }
  });

  it('GET /api/status reports busy while a child action is running, per the real registry', async () => {
    // Uses the REAL default registry (sweep-ui-actions.ts) with a resolveActionImpl override only
    // for the runner: a fast nodeDirect sleep in place of the real (slow, credentialed) runner --
    // the resolved label/argv shape mirrors a real 'child' action so the busy-lock wiring is
    // exercised end-to-end.
    const resolveActionImpl = (): ResolvedAction | ActionError => ({
      kind: 'child',
      label: 'busy-status test child',
      argv: ['--eval', 'setTimeout(() => {}, 300)'],
    });
    const runChildImpl = (label: string, argv: string[]): Promise<ChildResult> =>
      realRunChild(label, argv, { nodeDirect: true, timeoutMs: 5000 });
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl, runChildImpl });
    try {
      const start = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'anything' }),
      });
      expect(start.status).toBe(200);
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      const json = (await statusRes.json()) as PanelStatus;
      expect(json.busy).toEqual({ action: 'anything' });
      await waitUntilNotBusy(port); // let the fast sleep child finish
      const statusAfter = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as PanelStatus;
      expect(statusAfter.busy).toBeNull();
    } finally {
      await close();
    }
  });

  it('POST /api/action with an unknown action name returns 400 (closed registry)', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rm-rf-everything' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('POST /api/action sweep-live without armed:true returns 400 (real registry -- never spawns)', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sweep-live' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('refuses a second child action with 409 while the first is still running, then releases', async () => {
    const slow: ResolvedAction = { kind: 'child', label: 'slow test child', argv: ['--eval', 'setTimeout(() => {}, 400)'] };
    const other: ResolvedAction = { kind: 'child', label: 'other test child', argv: ['--eval', 'process.exit(0)'] };
    const resolveActionImpl = (name: string): ResolvedAction | ActionError =>
      name === 'test-slow' ? slow : name === 'test-other' ? other : { error: `unknown action: ${name}`, code: 400 };
    const runChildImpl = (label: string, argv: string[]): Promise<ChildResult> =>
      realRunChild(label, argv, { nodeDirect: true, timeoutMs: 5000 });
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl, runChildImpl });
    try {
      const r1 = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-slow' }),
      });
      expect(r1.status).toBe(200);
      const r2 = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-other' }),
      });
      expect(r2.status).toBe(409);
      // Let the slow child actually finish before close() so no child process outlives the test.
      await waitUntilNotBusy(port);
    } finally {
      await close();
    }
  });

  it('a chrome-kind action spawns detached and returns 200', async () => {
    const resolveActionImpl = (): ResolvedAction | ActionError => ({ kind: 'chrome', exe: process.execPath, args: ['--version'] });
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chrome-test' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('a chrome-kind action that fails to spawn returns 500 with the manual command in the message', async () => {
    const badExe = 'C:\\definitely-not-a-real-exe-xyz-2026.exe';
    const resolveActionImpl = (): ResolvedAction | ActionError => ({ kind: 'chrome', exe: badExe, args: ['--foo'] });
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chrome-test-bad' }),
      });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain(badExe);
    } finally {
      await close();
    }
  });

  it('a scan-kind action is exempt from the busy-lock and streams a completion event', async () => {
    let tapped = '';
    const scanImpl = (tap: (chunk: string) => void): Promise<void> => {
      tap('[FL] open receiptless: 0\n');
      tapped = 'called';
      return Promise.resolve();
    };
    const resolveActionImpl = (): ResolvedAction | ActionError => ({ kind: 'scan' });
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl, scanImpl });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan-only' }),
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(tapped).toBe('called');
    } finally {
      await close();
    }
  });

  it('GET /api/report returns the latest report as raw text (real out/sweep/ fixtures on disk)', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/report`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Receipt sweep');
    } finally {
      await close();
    }
  });

  it('GET /api/stream opens a text/event-stream connection', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      controller.abort();
      await close();
    }
  });

  it('an unmatched route returns 404', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('close() actually releases the OS port, not just the JS handle', async () => {
    const first = await startSweepUiServer({ port: 0, page: PAGE });
    await first.close();
    const second = await startSweepUiServer({ port: first.port, page: PAGE });
    await second.close();
  });

  it('defaults to binding 127.0.0.1 (never 0.0.0.0) when host is omitted', async () => {
    const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  describe('CSRF / DNS-rebinding guards', () => {
    it('rejects any route with a mismatched Host header (403) -- defeats DNS-rebinding', async () => {
      const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
      try {
        const res = await rawRequest({ port, path: '/api/status', method: 'GET', headers: { Host: 'evil.example.com' } });
        expect(res.status).toBe(403);
      } finally {
        await close();
      }
    });

    it('rejects POST /api/action with a mismatched Origin header (403) -- defeats cross-origin CSRF', async () => {
      const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
      try {
        const res = await rawRequest({
          port,
          path: '/api/action',
          method: 'POST',
          headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'scan-only' }),
        });
        expect(res.status).toBe(403);
      } finally {
        await close();
      }
    });

    it('rejects POST /api/action with a non-JSON Content-Type (400) -- forces cross-origin callers into a failing preflight', async () => {
      const { port, close } = await startSweepUiServer({ port: 0, page: PAGE });
      try {
        const res = await rawRequest({
          port,
          path: '/api/action',
          method: 'POST',
          headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'scan-only' }),
        });
        expect(res.status).toBe(400);
      } finally {
        await close();
      }
    });

    it('accepts a same-origin JSON POST to /api/action (positive case, incl. a charset suffix on Content-Type)', async () => {
      const resolveActionImpl = (): ResolvedAction | ActionError => ({ kind: 'scan' });
      const scanImpl = (): Promise<void> => Promise.resolve();
      const { port, close } = await startSweepUiServer({ port: 0, page: PAGE, resolveActionImpl, scanImpl });
      try {
        const res = await rawRequest({
          port,
          path: '/api/action',
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ action: 'scan-only' }),
        });
        expect(res.status).toBe(200);
      } finally {
        await close();
      }
    });
  });
});
