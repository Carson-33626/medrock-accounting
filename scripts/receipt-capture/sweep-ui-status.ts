// web/scripts/receipt-capture/sweep-ui-status.ts
//
// Pure status assembly for the Sweep Control Panel (DS 2026-07-29 §3 GET /api/status): turns
// injected fs/network reads into the VendorCard model the page renders. assembleStatus never
// touches node:fs or the network directly — every read flows through StatusDeps, so tests build
// the whole card set from an in-memory fake and never need real files on disk.
//
// checkTopRx (./sweep-preflight) is reused as-is: it only ever reads `env`, which StatusDeps
// already injects, so it's naturally testable with no changes. checkUline is NOT reused here —
// its signature takes a real directory path and calls node:fs itself (existsSync), which would
// bypass the injected StatusDeps and make this module untestable without real files. The ULINE
// cards below reimplement its FL/TN-joint, TX-solo shape (see sweep-preflight.ts's own comment)
// directly against deps.statePath instead.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { checkTopRx, checkCdp } from './sweep-preflight';
import { ALL_ENTITIES } from '../ramp-split-push/types';

export type Light = 'green' | 'amber' | 'red';

export interface VendorCard {
  key: string;
  label: string;
  light: Light;
  detail: string;
  actions: string[];
}

export interface PanelStatus {
  vendors: VendorCard[];
  lastSweep: { runId: string; total: number; cents: number } | null;
  latestReport: string | null;
  busy: { action: string } | null;
}

export interface FileInfo {
  exists: boolean;
  mtimeMs: number;
}

export interface SweepStateFile {
  lastScanCsv: string | null;
  history: { runId: string; total: number; cents: number }[];
}

export interface StatusDeps {
  env: NodeJS.ProcessEnv;
  // null only on an unexpected stat error (permissions, etc) — a plain missing file is
  // { exists: false, mtimeMs: 0 }, not null, so callers don't have to special-case the common case.
  statePath(file: string): FileInfo | null;
  // Concrete reader (not a generic JSON passthrough) — state.json is the only structured file
  // this module ever parses, so there's no value in a generic<T> shape here, and a concrete
  // signature keeps every test double explicitly typed with zero any/unknown.
  sweepState(): SweepStateFile | null;
  listDir(dir: string): string[];
  cdpCheck(url: string): Promise<{ reachable: boolean; detail: string }>;
  now(): number;
  busy(): { action: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 14;

const ULINE_STATE_DIR = 'scripts/receipt-capture/.state';
const SWEEP_OUT = 'scripts/receipt-capture/out/sweep';
const WALMART_CACHE = 'scripts/walmart-enrich/out/extraction-cache.json';
const AMAZON_CSV_ACCOUNTS = ['FL', 'TN', 'TX'] as const;
const AMAZON_CSV_PDF_DIR = 'scripts/amazon-csv-enrich/.receipts_cache/_shared';
const DEFAULT_WM_CDP_URL = 'http://127.0.0.1:9222';

function ageDays(mtimeMs: number, now: number): number {
  return Math.max(0, Math.floor((now - mtimeMs) / DAY_MS));
}

function toprxCard(deps: StatusDeps): VendorCard {
  const r = checkTopRx(deps.env);
  const light: Light = r.entities.length === ALL_ENTITIES.length ? 'green' : r.entities.length > 0 ? 'amber' : 'red';
  return { key: 'toprx', label: 'TopRx', light, detail: r.detail, actions: [] };
}

function ulineSessionCard(key: string, label: string, file: string, actions: string[], deps: StatusDeps): VendorCard {
  const info = deps.statePath(file);
  if (!info || !info.exists) return { key, label, light: 'red', detail: 'no session — needs bootstrap', actions };
  const days = ageDays(info.mtimeMs, deps.now());
  if (days >= STALE_DAYS) return { key, label, light: 'amber', detail: `session ${days}d old — re-bootstrap recommended`, actions };
  return { key, label, light: 'green', detail: `session ${days}d old`, actions };
}

async function walmartCard(deps: StatusDeps): Promise<VendorCard> {
  const cdp = await deps.cdpCheck(deps.env.WM_CDP_URL ?? DEFAULT_WM_CDP_URL);
  const cache = deps.statePath(WALMART_CACHE);
  const cacheDetail = cache && cache.exists ? `cache ${ageDays(cache.mtimeMs, deps.now())}d old` : 'no cache yet';
  return {
    key: 'walmart',
    label: 'Walmart',
    light: cdp.reachable ? 'green' : 'red',
    detail: `${cdp.detail}; ${cacheDetail}`,
    actions: ['chrome-walmart'],
  };
}

function amazonCard(): VendorCard {
  // Ramp-API-only (run-amazon.ts un-split/order-ID flow) — no session, no cache, never blocked.
  return { key: 'amazon', label: 'Amazon (API)', light: 'green', detail: 'API-only, no session needed', actions: [] };
}

function amazonCsvCard(deps: StatusDeps): VendorCard {
  const perAccount = AMAZON_CSV_ACCOUNTS.map((a) => ({ account: a, info: deps.statePath(`scripts/amazon-csv-enrich/out/${a}/charges.json`) }));
  const present = perAccount.filter((a) => a.info && a.info.exists);
  const pdfCount = deps.listDir(AMAZON_CSV_PDF_DIR).length;
  let light: Light = 'red';
  if (present.length === AMAZON_CSV_ACCOUNTS.length) {
    const maxAge = Math.max(...present.map((a) => ageDays((a.info as FileInfo).mtimeMs, deps.now())));
    light = maxAge >= STALE_DAYS ? 'amber' : 'green';
  } else if (present.length > 0) {
    light = 'amber';
  }
  return {
    key: 'amazon-csv',
    label: 'Amazon-CSV (Business)',
    light,
    detail: `${present.length}/${AMAZON_CSV_ACCOUNTS.length} accounts cached, ${pdfCount} invoice PDF(s)`,
    actions: ['chrome-amazon', 'extract-amazon-FL', 'extract-amazon-TN', 'extract-amazon-TX', 'fetch-invoices', 'attach-amazon-csv-dry'],
  };
}

function lastSweep(deps: StatusDeps): PanelStatus['lastSweep'] {
  const state = deps.sweepState();
  if (!state || state.history.length === 0) return null;
  const last = state.history[state.history.length - 1];
  return { runId: last.runId, total: last.total, cents: last.cents };
}

function latestReport(deps: StatusDeps): string | null {
  const files = deps.listDir(SWEEP_OUT).filter((f) => /^report-.*\.md$/.test(f));
  if (files.length === 0) return null;
  // report-<runId>.md filenames embed an ISO-ish timestamp (run-sweep.ts), so a lexicographic
  // sort is also a chronological sort — no need to stat every file to find the newest.
  return [...files].sort().at(-1) ?? null;
}

export async function assembleStatus(deps: StatusDeps): Promise<PanelStatus> {
  const vendors: VendorCard[] = [
    toprxCard(deps),
    ulineSessionCard('uline-FLTN', 'ULINE FL+TN', `${ULINE_STATE_DIR}/uline-FL.json`, ['bootstrap-uline-FL'], deps),
    ulineSessionCard('uline-TX', 'ULINE TX', `${ULINE_STATE_DIR}/uline-TX.json`, ['bootstrap-uline-TX'], deps),
    await walmartCard(deps),
    amazonCard(),
    amazonCsvCard(deps),
  ];
  return {
    vendors,
    lastSweep: lastSweep(deps),
    latestReport: latestReport(deps),
    busy: deps.busy(),
  };
}

// Real fs/network wiring for the server (Task 2). Everything above stays pure; this is the one
// place that touches node:fs. `getBusy` is a closure the server owns (tracks its own running
// child) — status assembly has no process-tracking state of its own.
export function defaultStatusDeps(getBusy: () => { action: string } | null = () => null): StatusDeps {
  return {
    env: process.env,
    statePath: (file) => {
      try {
        if (!existsSync(file)) return { exists: false, mtimeMs: 0 };
        return { exists: true, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    },
    sweepState: () => {
      const file = `${SWEEP_OUT}/state.json`;
      try {
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8')) as SweepStateFile;
      } catch {
        return null;
      }
    },
    listDir: (dir) => {
      try {
        return existsSync(dir) ? readdirSync(dir) : [];
      } catch {
        return [];
      }
    },
    cdpCheck: checkCdp,
    now: () => Date.now(),
    busy: getBusy,
  };
}
