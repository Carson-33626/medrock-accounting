// web/scripts/receipt-capture/sweep-ui-server.ts
//
// Loopback node:http server for the Sweep Control Panel (DS 2026-07-29 §3.2). Wires the pure
// Task 1 modules (assembleStatus, resolveAction) to real routes: GET / (the page), GET
// /api/status, GET /api/report, GET /api/stream (SSE), POST /api/action. Binds 127.0.0.1 by
// default -- NEVER 0.0.0.0 (this drives headed logins, detached Chrome, and live Ramp writes on
// Carson's own machine). Loopback narrows *reachability* but is not by itself a CSRF/DNS-rebinding
// boundary -- see hostMatches/originMatches/isJsonContentType below and README "Loopback-only,
// plus CSRF/host guards".
//
// Test seams: resolveActionImpl / runChildImpl / scanImpl let tests substitute the real registry
// lookup, the real (slow, credentialed) child runner, and the real (network-hitting) scan with
// fast, injectable fakes -- production callers omit all three and get the real defaults.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { assembleStatus, defaultStatusDeps } from './sweep-ui-status';
import { resolveAction as defaultResolveAction } from './sweep-ui-actions';
import type { ResolvedAction, ActionError, ActionRequestBody } from './sweep-ui-actions';
import { runChild as defaultRunChild } from './sweep-exec';
import { scanEntity } from './sweep-scan';
import { rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';

const SWEEP_OUT = 'scripts/receipt-capture/out/sweep';
const TAIL_MAX = 16 * 1024;
// Grace window to let a synchronous-ish spawn failure (e.g. ENOENT) surface via the child's
// 'error' event before the server declares the detached launch successful and detaches from it.
// spawn() failures are always async (never a throw), so there is no way to know synchronously.
const CHROME_SPAWN_GRACE_MS = 50;

interface ActionPostBody {
  action?: string;
  armed?: boolean;
}

function isActionError(r: ResolvedAction | ActionError): r is ActionError {
  return 'error' in r;
}

// CSRF / DNS-rebinding guards (loopback alone is not a complete access boundary -- see README
// "Loopback-only, plus CSRF/host guards"). `port` must always be the server's REAL bound port
// (opts.port is 0 in every test, so a constant here would never match).
function hostMatches(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// No Origin header at all (same-origin navigations, curl, non-browser tools) is allowed through --
// only a PRESENT-but-wrong Origin is rejected. That's what defeats a cross-origin page's fetch/form
// POST without also blocking legitimate same-machine callers that never send the header.
function originMatches(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

// Real Ramp-hitting scan (S1-style, per DS §3.2 'scan-only'): read-only, no files written. Not
// exercised by any test (would require live Ramp creds) -- swapped for scanImpl in tests.
async function defaultScan(tap: (chunk: string) => void): Promise<void> {
  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    const rows = await scanEntity(entity, token);
    const cents = rows.reduce((a, r) => a + Math.abs(r.amountCents), 0);
    tap(`[${entity}] open receiptless: ${rows.length} ($${(cents / 100).toFixed(2)})\n`);
  }
}

function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(body);
}

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<ActionPostBody> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (data.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as ActionPostBody);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export interface SweepUiServerOpts {
  port: number;
  host?: string;
  page: string;
  resolveActionImpl?: typeof defaultResolveAction;
  runChildImpl?: typeof defaultRunChild;
  scanImpl?: (tap: (chunk: string) => void) => Promise<void>;
}

export interface SweepUiServerHandle {
  close(): Promise<void>;
  port: number;
}

export function startSweepUiServer(opts: SweepUiServerOpts): Promise<SweepUiServerHandle> {
  const resolveActionFn = opts.resolveActionImpl ?? defaultResolveAction;
  const runChildFn = opts.runChildImpl ?? defaultRunChild;
  const scanFn = opts.scanImpl ?? defaultScan;

  // Busy-lock + SSE tail state: one server instance mirrors the "never two sweeps" rule for
  // itself (see DS §2). Kept as closure state (not a true ES-module top-level) so multiple
  // ephemeral test instances in the same process never share state.
  let current: { action: string } | null = null;
  let tail = '';
  const subscribers = new Set<ServerResponse>();
  // Real bound port -- opts.port is 0 in every test (OS-assigned ephemeral port), so this is
  // filled in from server.address() once listen() resolves, before any request can arrive.
  let boundPort = opts.port;

  function appendTail(chunk: string): void {
    tail = (tail + chunk).slice(-TAIL_MAX);
  }

  function broadcastData(chunk: string): void {
    appendTail(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      for (const sub of subscribers) sub.write(`data: ${line}\n\n`);
    }
  }

  function broadcastDone(code: number | null): void {
    const payload = JSON.stringify({ code });
    for (const sub of subscribers) sub.write(`event: done\ndata: ${payload}\n\n`);
  }

  const statusDeps = defaultStatusDeps(() => current);

  async function handleStatus(res: ServerResponse): Promise<void> {
    const status = await assembleStatus(statusDeps);
    sendJson(res, 200, status);
  }

  function handleReport(res: ServerResponse): void {
    if (!existsSync(SWEEP_OUT)) {
      sendText(res, 404, 'no reports yet');
      return;
    }
    const files = readdirSync(SWEEP_OUT).filter((f) => /^report-.*\.md$/.test(f));
    if (files.length === 0) {
      sendText(res, 404, 'no reports yet');
      return;
    }
    // Filenames embed an ISO-ish timestamp (run-sweep.ts) -- lexicographic sort is chronological.
    const latest = [...files].sort().at(-1) as string;
    const body = readFileSync(`${SWEEP_OUT}/${latest}`, 'utf8');
    sendText(res, 200, body);
  }

  function handleStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    if (tail.length > 0) {
      for (const line of tail.split(/\r?\n/)) {
        if (line.length > 0) res.write(`data: ${line}\n\n`);
      }
    }
    subscribers.add(res);
    res.on('close', () => subscribers.delete(res));
  }

  // kind 'child': runs in the background -- the HTTP response returns immediately after spawning
  // so a second request arriving while it's still running observes `current` and gets 409. The
  // tail buffer resets per run (this endpoint's SSE feed is "the currently/most-recently running
  // child's output", not a cross-run transcript).
  async function runChildAction(name: string, action: { label: string; argv: string[] }): Promise<void> {
    current = { action: name };
    tail = '';
    try {
      const result = await runChildFn(action.label, action.argv, { onData: broadcastData });
      broadcastDone(result.code);
    } catch (e) {
      // Mirrors the scan path's failure handling below: a thrown/rejected runner must still
      // release the lock and tell the panel it's done, not leave the UI wedged "busy" forever.
      broadcastData(`${action.label} failed to run: ${(e as Error).message}\n`);
      broadcastDone(null);
    } finally {
      current = null;
    }
  }

  function spawnChrome(exe: string, args: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        const cmd = [exe, ...args].join(' ');
        resolve({ ok: false, message: `failed to launch Chrome: ${err.message} -- run manually: ${cmd}` });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true });
      }, CHROME_SPAWN_GRACE_MS);
    });
  }

  async function handleAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Requiring an exact application/json Content-Type forces any cross-origin caller into a
    // CORS preflight -- and this server never sends CORS headers, so that preflight always fails.
    // A plain cross-origin <form> POST or fetch() with a "simple" content-type never gets here.
    if (!isJsonContentType(req.headers['content-type'])) {
      sendJson(res, 400, { error: 'invalid content-type: expected application/json' });
      return;
    }
    let body: ActionPostBody;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: `invalid request body: ${(e as Error).message}` });
      return;
    }
    const name = typeof body.action === 'string' ? body.action : '';
    const armed: ActionRequestBody = { armed: body.armed === true };
    const resolved = resolveActionFn(name, armed);
    if (isActionError(resolved)) {
      sendJson(res, 400, resolved);
      return;
    }

    if (resolved.kind === 'chrome') {
      const r = await spawnChrome(resolved.exe, resolved.args);
      if (!r.ok) {
        sendJson(res, 500, { error: r.message });
        return;
      }
      sendJson(res, 200, { ok: true, launched: name });
      return;
    }

    if (resolved.kind === 'scan') {
      // Exempt from the busy-lock (DS §3.2 interface note: read-only, no files written, safe to
      // run any time). Trade-off: if a scan and a child run concurrently their outputs share one
      // SSE tail and can interleave -- acceptable for a rare, read-only, Carson-only v1 button.
      tail = '';
      void scanFn(broadcastData).then(
        () => broadcastDone(0),
        (e: Error) => {
          broadcastData(`scan failed: ${e.message}\n`);
          broadcastDone(1);
        },
      );
      sendJson(res, 200, { ok: true, started: 'scan-only' });
      return;
    }

    // kind === 'child'
    if (current !== null) {
      sendJson(res, 409, { error: `busy: ${current.action} is running` });
      return;
    }
    void runChildAction(name, resolved);
    sendJson(res, 200, { ok: true, label: resolved.label });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    // Host-header check applies to every route: it's what defeats DNS-rebinding (a remote page
    // navigating a hostname that resolves to 127.0.0.1, so the browser's same-origin checks think
    // it's talking to the attacker's origin while the actual TCP connection lands here).
    if (!hostMatches(req.headers.host, boundPort)) {
      sendJson(res, 403, { error: 'forbidden: bad Host header' });
      return;
    }
    // Origin check applies to POSTs only (the state-changing route): a present-but-mismatched
    // Origin means a cross-origin page's script fired the request, not this page's own JS.
    if (req.method === 'POST' && !originMatches(req.headers.origin, boundPort)) {
      sendJson(res, 403, { error: 'forbidden: bad Origin header' });
      return;
    }
    if (req.method === 'GET' && url === '/') {
      sendHtml(res, 200, opts.page);
      return;
    }
    if (req.method === 'GET' && url === '/api/status') {
      await handleStatus(res);
      return;
    }
    if (req.method === 'GET' && url === '/api/report') {
      handleReport(res);
      return;
    }
    if (req.method === 'GET' && url === '/api/stream') {
      handleStream(res);
      return;
    }
    if (req.method === 'POST' && url === '/api/action') {
      await handleAction(req, res);
      return;
    }
    sendText(res, 404, 'not found');
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((e: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const address = server.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            for (const sub of subscribers) {
              try {
                sub.end();
              } catch {
                // already closed by the client
              }
            }
            subscribers.clear();
            server.closeAllConnections();
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
