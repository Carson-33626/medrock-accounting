import { describe, it, expect, vi } from 'vitest';
import { assembleStatus } from './sweep-ui-status';
import type { StatusDeps, FileInfo, PanelStatus, SweepStateFile } from './sweep-ui-status';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): number => NOW - n * DAY_MS;

function baseDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    env: {} as NodeJS.ProcessEnv,
    statePath: () => ({ exists: false, mtimeMs: 0 }),
    sweepState: () => null,
    listDir: () => [],
    cdpCheck: async () => ({ reachable: false, detail: 'no Chrome' }),
    now: () => NOW,
    busy: () => null,
    ...overrides,
  };
}

function fileMap(entries: Record<string, FileInfo | null>): StatusDeps['statePath'] {
  return (file: string) => (file in entries ? entries[file] : { exists: false, mtimeMs: 0 });
}

function cardByKey(status: PanelStatus, key: string) {
  const card = status.vendors.find((v) => v.key === key);
  if (!card) throw new Error(`no vendor card for key ${key}`);
  return card;
}

describe('assembleStatus — never touches real fs/network (fully-faked deps)', () => {
  it('produces exactly the nine documented vendor cards', async () => {
    const status = await assembleStatus(baseDeps());
    expect(status.vendors.map((v) => v.key).sort()).toEqual(
      ['amazon', 'amazon-csv', 'letco', 'medisca', 'sams', 'toprx', 'uline-FLTN', 'uline-TX', 'walmart'].sort(),
    );
  });

  // Letco is the first BILL vendor on the panel — creds are the only thing that can block it, so
  // the light must not depend on a session file or cache it will never have.
  describe('letco light', () => {
    const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

    it('green when all three entities have portal creds', async () => {
      const status = await assembleStatus(baseDeps({
        env: env({ LETCO_FL: 'a', LETCO_FL_Pass: 'b', LETCO_TN: 'c', LETCO_TN_Pass: 'd', LETCO_TX: 'e', LETCO_TX_Pass: 'f' }),
      }));
      expect(cardByKey(status, 'letco').light).toBe('green');
    });

    it('amber on partial creds and red on none', async () => {
      const partial = await assembleStatus(baseDeps({ env: env({ LETCO_FL: 'a', LETCO_FL_Pass: 'b' }) }));
      expect(cardByKey(partial, 'letco').light).toBe('amber');
      const none = await assembleStatus(baseDeps({ env: env({}) }));
      expect(cardByKey(none, 'letco').light).toBe('red');
    });
  });

  describe('toprx light', () => {
    it('green when all three entities have creds', async () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TopRX_FL: 'u', TopRX_FL_Pass: 'p', TopRX_TN: 'u', TopRX_TN_Pass: 'p', TopRX_TX: 'u', TopRX_TX_Pass: 'p' };
      const status = await assembleStatus(baseDeps({ env }));
      expect(cardByKey(status, 'toprx').light).toBe('green');
    });
    it('amber when only some entities have creds', async () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TopRX_FL: 'u', TopRX_FL_Pass: 'p' };
      const status = await assembleStatus(baseDeps({ env }));
      expect(cardByKey(status, 'toprx').light).toBe('amber');
    });
    it('red when no entity has creds', async () => {
      const status = await assembleStatus(baseDeps());
      expect(cardByKey(status, 'toprx').light).toBe('red');
    });
    it('has no action buttons (creds fixed via .env.local only)', async () => {
      const status = await assembleStatus(baseDeps());
      expect(cardByKey(status, 'toprx').actions).toEqual([]);
    });
  });

  describe('uline-FLTN light (FL session age; TN rides FL)', () => {
    it('red when no FL session file exists', async () => {
      const status = await assembleStatus(baseDeps());
      const card = cardByKey(status, 'uline-FLTN');
      expect(card.light).toBe('red');
      expect(card.actions).toEqual(['bootstrap-uline-FL']);
    });
    it('green when FL session is fresh (< 14 days old)', async () => {
      const statePath = fileMap({ 'scripts/receipt-capture/.state/uline-FL.json': { exists: true, mtimeMs: daysAgo(2) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'uline-FLTN').light).toBe('green');
    });
    it('amber when FL session is exactly 14 days old (boundary)', async () => {
      const statePath = fileMap({ 'scripts/receipt-capture/.state/uline-FL.json': { exists: true, mtimeMs: daysAgo(14) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'uline-FLTN').light).toBe('amber');
    });
    it('amber when FL session is older than 14 days', async () => {
      const statePath = fileMap({ 'scripts/receipt-capture/.state/uline-FL.json': { exists: true, mtimeMs: daysAgo(30) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'uline-FLTN').light).toBe('amber');
    });
  });

  describe('uline-TX light (independent of FL/TN)', () => {
    it('red when no TX session exists even if FL is fresh', async () => {
      const statePath = fileMap({ 'scripts/receipt-capture/.state/uline-FL.json': { exists: true, mtimeMs: daysAgo(1) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'uline-TX').light).toBe('red');
      expect(cardByKey(status, 'uline-TX').actions).toEqual(['bootstrap-uline-TX']);
    });
    it('green when TX session is fresh', async () => {
      const statePath = fileMap({ 'scripts/receipt-capture/.state/uline-TX.json': { exists: true, mtimeMs: daysAgo(0) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'uline-TX').light).toBe('green');
    });
  });

  describe('walmart light (CDP + cache)', () => {
    it('green when CDP is reachable', async () => {
      const status = await assembleStatus(baseDeps({ cdpCheck: async () => ({ reachable: true, detail: 'Chrome CDP at http://127.0.0.1:9222' }) }));
      expect(cardByKey(status, 'walmart').light).toBe('green');
    });
    it('red when CDP is unreachable', async () => {
      const status = await assembleStatus(baseDeps({ cdpCheck: async () => ({ reachable: false, detail: 'no Chrome at http://127.0.0.1:9222' }) }));
      expect(cardByKey(status, 'walmart').light).toBe('red');
    });
    it('detail reports cache age when the extraction cache exists', async () => {
      const statePath = fileMap({ 'scripts/walmart-enrich/out/extraction-cache.json': { exists: true, mtimeMs: daysAgo(3) } });
      const status = await assembleStatus(baseDeps({ statePath, cdpCheck: async () => ({ reachable: true, detail: 'up' }) }));
      expect(cardByKey(status, 'walmart').detail).toContain('3d old');
    });
    it('has exactly the chrome-walmart action', async () => {
      const status = await assembleStatus(baseDeps());
      expect(cardByKey(status, 'walmart').actions).toEqual(['chrome-walmart']);
    });
  });

  describe("sam's club light (shares Walmart's Chrome, own cache)", () => {
    it('green when CDP is reachable', async () => {
      const status = await assembleStatus(baseDeps({ cdpCheck: async () => ({ reachable: true, detail: 'up' }) }));
      expect(cardByKey(status, 'sams').light).toBe('green');
    });
    it('red when CDP is unreachable', async () => {
      const status = await assembleStatus(baseDeps({ cdpCheck: async () => ({ reachable: false, detail: 'no Chrome' }) }));
      expect(cardByKey(status, 'sams').light).toBe('red');
    });
    // The whole point of a separate card: Sam's must read the SAMS cache, not Walmart's. A card that
    // reported Walmart's cache age would show green-and-fresh while Sam's had never been extracted.
    it('reads its OWN cache, not the Walmart one', async () => {
      const statePath = fileMap({
        'scripts/walmart-enrich/out/extraction-cache.json': { exists: true, mtimeMs: daysAgo(1) },
        'scripts/walmart-enrich/out/sams/extraction-cache.json': { exists: true, mtimeMs: daysAgo(9) },
      });
      const status = await assembleStatus(baseDeps({ statePath, cdpCheck: async () => ({ reachable: true, detail: 'up' }) }));
      expect(cardByKey(status, 'sams').detail).toContain('9d old');
      expect(cardByKey(status, 'walmart').detail).toContain('1d old');
    });
    it('says so when Sam\'s has no cache even though Walmart does', async () => {
      const statePath = fileMap({ 'scripts/walmart-enrich/out/extraction-cache.json': { exists: true, mtimeMs: daysAgo(1) } });
      const status = await assembleStatus(baseDeps({ statePath, cdpCheck: async () => ({ reachable: true, detail: 'up' }) }));
      expect(cardByKey(status, 'sams').detail).toContain('no cache yet');
    });
  });

  describe('amazon (API-only) — always green, no actions', () => {
    it('is always green regardless of env/fs/network state', async () => {
      const status = await assembleStatus(baseDeps());
      const card = cardByKey(status, 'amazon');
      expect(card.light).toBe('green');
      expect(card.actions).toEqual([]);
    });
  });

  describe('amazon-csv light (per-account cache ages + invoice-pdf count)', () => {
    it('red when zero accounts have a transactions.csv', async () => {
      const status = await assembleStatus(baseDeps());
      expect(cardByKey(status, 'amazon-csv').light).toBe('red');
    });
    it('amber when only some accounts are cached', async () => {
      const statePath = fileMap({ 'scripts/amazon-csv-enrich/out/FL/transactions.csv': { exists: true, mtimeMs: daysAgo(1) } });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'amazon-csv').light).toBe('amber');
    });
    it('green when all three accounts are cached and fresh', async () => {
      const statePath = fileMap({
        'scripts/amazon-csv-enrich/out/FL/transactions.csv': { exists: true, mtimeMs: daysAgo(1) },
        'scripts/amazon-csv-enrich/out/TN/transactions.csv': { exists: true, mtimeMs: daysAgo(2) },
        'scripts/amazon-csv-enrich/out/TX/transactions.csv': { exists: true, mtimeMs: daysAgo(3) },
      });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'amazon-csv').light).toBe('green');
    });
    it('amber when all three accounts are cached but the oldest is stale (>= 14 days)', async () => {
      const statePath = fileMap({
        'scripts/amazon-csv-enrich/out/FL/transactions.csv': { exists: true, mtimeMs: daysAgo(1) },
        'scripts/amazon-csv-enrich/out/TN/transactions.csv': { exists: true, mtimeMs: daysAgo(20) },
        'scripts/amazon-csv-enrich/out/TX/transactions.csv': { exists: true, mtimeMs: daysAgo(3) },
      });
      const status = await assembleStatus(baseDeps({ statePath }));
      expect(cardByKey(status, 'amazon-csv').light).toBe('amber');
    });
    it('detail reports invoice-pdf count from the shared receipts cache', async () => {
      const status = await assembleStatus(baseDeps({ listDir: (dir) => (dir === 'scripts/amazon-csv-enrich/.receipts_cache/_shared' ? ['amazon-111.pdf', 'amazon-222.pdf'] : []) }));
      expect(cardByKey(status, 'amazon-csv').detail).toContain('2 invoice PDF');
    });
    it('carries the full extract/fetch/attach action set', async () => {
      const status = await assembleStatus(baseDeps());
      expect(cardByKey(status, 'amazon-csv').actions).toEqual([
        'chrome-amazon', 'extract-amazon-FL', 'extract-amazon-TN', 'extract-amazon-TX', 'fetch-invoices', 'attach-amazon-csv-dry',
      ]);
    });
  });

  describe('lastSweep', () => {
    it('null when state.json is missing', async () => {
      const status = await assembleStatus(baseDeps());
      expect(status.lastSweep).toBeNull();
    });
    it('null when state.json has an empty history', async () => {
      const status = await assembleStatus(baseDeps({ sweepState: () => ({ lastScanCsv: null, history: [] }) }));
      expect(status.lastSweep).toBeNull();
    });
    it('reports the most recent history entry', async () => {
      const sweepState = vi.fn((): SweepStateFile => ({
        lastScanCsv: 'out/sweep/scan-x-after.csv',
        history: [
          { runId: 'sweep-old', total: 50, cents: 500000 },
          { runId: 'sweep-new', total: 12, cents: 123456 },
        ],
      }));
      const status = await assembleStatus(baseDeps({ sweepState }));
      expect(status.lastSweep).toEqual({ runId: 'sweep-new', total: 12, cents: 123456 });
    });
  });

  describe('latestReport', () => {
    it('null when no report files exist', async () => {
      const status = await assembleStatus(baseDeps());
      expect(status.latestReport).toBeNull();
    });
    it('picks the lexicographically-last report-*.md (timestamped filenames sort chronologically)', async () => {
      const listDir = (dir: string): string[] =>
        dir === 'scripts/receipt-capture/out/sweep'
          ? ['report-sweep-2026-07-20T10-00-00-000Z.md', 'report-sweep-2026-07-27T10-00-00-000Z.md', 'residual-queue.csv']
          : [];
      const status = await assembleStatus(baseDeps({ listDir }));
      expect(status.latestReport).toBe('report-sweep-2026-07-27T10-00-00-000Z.md');
    });
  });

  describe('busy', () => {
    it('passes through the injected busy() reader untouched', async () => {
      const status = await assembleStatus(baseDeps({ busy: () => ({ action: 'sweep-live' }) }));
      expect(status.busy).toEqual({ action: 'sweep-live' });
    });
    it('is null when nothing is running', async () => {
      const status = await assembleStatus(baseDeps());
      expect(status.busy).toBeNull();
    });
  });
});
