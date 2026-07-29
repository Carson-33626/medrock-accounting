// web/scripts/receipt-capture/run-sweep.ts
// THE one-command receipt sweep (spec 2026-07-28): scan everything open, run every vendor
// pipeline that has access, re-scan, and emit report + residual queue. LIVE BY DEFAULT with no
// caps (Carson 2026-07-28) — --dry-run opts down; every underlying runner keeps its own gates.
//   npx tsx scripts/receipt-capture/run-sweep.ts [--dry-run] [--vendor toprx,uline,amazon,walmart,amazon-csv] [--limit N] [--skip-scan]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanEntity, rollupByMerchant, scanCsvLine, SCAN_CSV_HEADER } from './sweep-scan';
import type { ScanRow } from './sweep-scan';
import { checkTopRx, checkUline, checkCdp } from './sweep-preflight';
import { runChild } from './sweep-exec';
import type { ChildResult } from './sweep-exec';
import { parseNumericFlag } from './cli-args';
import { rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';

const OUT = 'scripts/receipt-capture/out/sweep';
const STATE_PATH = `${OUT}/state.json`;
const ULINE_STATE_DIR = 'scripts/receipt-capture/.state';
const WM_CDP = process.env.WM_CDP_URL ?? 'http://127.0.0.1:9222';
const ALL_VENDORS = ['toprx', 'uline', 'amazon', 'walmart', 'amazon-csv'] as const;
type Vendor = (typeof ALL_VENDORS)[number];

interface SweepState { lastScanCsv: string | null; history: { runId: string; total: number; cents: number }[] }

interface Args { dryRun: boolean; vendors: Vendor[]; limit: number; skipScan: boolean }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const vendorArg = get('--vendor');
  const vendors = vendorArg ? (vendorArg.split(',').map((s) => s.trim()) as Vendor[]) : [...ALL_VENDORS];
  for (const v of vendors) if (!ALL_VENDORS.includes(v)) throw new Error(`Unknown --vendor ${v as string}`);
  return {
    dryRun: argv.includes('--dry-run'),
    vendors,
    limit: parseNumericFlag('--limit', get('--limit'), 999999, 'clamp'),
    skipScan: argv.includes('--skip-scan'),
  };
}

const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function loadState(): SweepState {
  if (!existsSync(STATE_PATH)) return { lastScanCsv: null, history: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SweepState;
  } catch {
    return { lastScanCsv: null, history: [] };
  }
}

async function fullScan(): Promise<ScanRow[]> {
  const all: ScanRow[] = [];
  for (const e of ALL_ENTITIES) {
    const token = await rampToken(e, 'transactions:read');
    const rows = await scanEntity(e, token);
    console.log(`  [${e}] open txns missing receipt: ${rows.length} (${money(rows.reduce((a, r) => a + Math.abs(r.amountCents), 0))})`);
    all.push(...rows);
  }
  return all;
}

function writeScanCsv(path: string, rows: ScanRow[]): void {
  writeFileSync(path, [SCAN_CSV_HEADER, ...rows.map(scanCsvLine)].join('\n') + '\n');
}

function readScanIds(path: string): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  // txn_id is column 2; scan rows never quote it (uuid) so a plain split is safe for THIS column.
  return new Set(lines.map((l) => l.split(',')[1]).filter(Boolean));
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const mode = args.dryRun ? 'DRY-RUN' : 'LIVE (no caps)';
  console.log(`${runId} | mode=${mode} | vendors=${args.vendors.join(',')}`);
  const state = loadState();
  const needsYou: string[] = [];
  const jobs: ChildResult[] = [];

  // ---- S0 preflight ----
  const toprx = checkTopRx(process.env);
  const uline = checkUline(ULINE_STATE_DIR);
  const wmCdp = await checkCdp(WM_CDP);
  if (toprx.needsYou) needsYou.push(toprx.needsYou);
  if (uline.needsYou) needsYou.push(uline.needsYou);
  if (!wmCdp.reachable) needsYou.push(`Walmart extract skipped (${wmCdp.detail}). Launch: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\wm-chrome-profile and sign into walmart.com`);
  needsYou.push('Amazon-CSV extract is always manual: sign each Business login into a CDP Chrome, then run scripts/amazon-csv-enrich/run-extract.ts --account <label>');
  console.log(`preflight: toprx[${toprx.detail}] uline[${uline.detail}] walmart-cdp[${wmCdp.reachable ? 'up' : 'down'}]`);

  // ---- S1 scan ----
  let before: ScanRow[] = [];
  if (!args.skipScan) {
    console.log('S1 scan:');
    before = await fullScan();
    writeScanCsv(`${OUT}/scan-${runId}-before.csv`, before);
  }
  const prevIds = readScanIds(state.lastScanCsv ?? '');
  const beforeIds = new Set(before.map((r) => r.id));
  const fixedSinceLast = [...prevIds].filter((id) => !beforeIds.has(id)).length;
  const newSinceLast = before.filter((r) => !prevIds.has(r.id)).length;

  // ---- S2/S3 vendor jobs (sequential) ----
  const lim = String(args.limit);
  const live = (base: string[]): string[] => (args.dryRun ? base : [...base, '--live']);
  const want = (v: Vendor): boolean => args.vendors.includes(v);

  if (want('toprx') && toprx.available) {
    for (const e of toprx.entities) {
      jobs.push(await runChild(`toprx-${e}`, live(['scripts/receipt-capture/run-toprx.ts', '--entity', e, '--limit', lim])));
    }
  }
  if (want('uline') && uline.available) {
    // FL and TN are one joint ULINE account (shared invoice roster) — one joint child covers
    // both, using FL's session; TN needs no session of its own. TX is a separate account and
    // still runs solo. Gate directly on entities[] membership rather than looping per-entity:
    // a per-entity loop would try to run TN standalone, which has no session to extract with.
    if (uline.entities.includes('FL')) {
      const csvPath = process.env.ULINE_CSV_FL;
      const extra = csvPath && existsSync(csvPath) ? ['--csv', csvPath] : [];
      jobs.push(await runChild('uline-FLTN', live(['scripts/receipt-capture/run-uline.ts', '--entity=FL,TN', '--limit', lim, ...extra])));
    }
    if (uline.entities.includes('TX')) {
      const csvPath = process.env.ULINE_CSV_TX;
      const extra = csvPath && existsSync(csvPath) ? ['--csv', csvPath] : [];
      jobs.push(await runChild('uline-TX', live(['scripts/receipt-capture/run-uline.ts', '--entity=TX', '--limit', lim, ...extra])));
    }
  }
  if (want('amazon')) {
    for (const e of ALL_ENTITIES) {
      jobs.push(await runChild(`amazon-${e}`, live(['scripts/receipt-capture/run-amazon.ts', '--entity', e, '--limit', lim])));
    }
  }
  if (want('walmart')) {
    if (wmCdp.reachable) jobs.push(await runChild('walmart-extract', ['scripts/walmart-enrich/run-cdp.ts']));
    if (existsSync('scripts/walmart-enrich/out/extraction-cache.json')) {
      jobs.push(await runChild('walmart-attach', live(['scripts/walmart-enrich/run-cdp-split.ts', '--cap', args.dryRun ? '0' : lim])));
    } else {
      needsYou.push('Walmart attach skipped: no extraction cache yet (needs one CDP extract run)');
    }
  }
  if (want('amazon-csv')) {
    const root = 'scripts/amazon-csv-enrich/out';
    const hasCache = existsSync(root) && readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory() && d.name !== '_attach' && existsSync(join(root, d.name, 'charges.json')));
    if (hasCache) jobs.push(await runChild('amazon-csv-attach', live(['scripts/amazon-csv-enrich/run-attach.ts', '--cap', args.dryRun ? '0' : lim])));
    else needsYou.push('Amazon-CSV attach skipped: no charge caches yet (run run-extract per Business login first)');
  }

  for (const j of jobs) {
    const note = j.label.startsWith('uline') && j.code === 2 ? ' (session expired - re-run bootstrap)'
      : j.label.startsWith('uline') && j.code === 3 ? ' (account identity mismatch - check ULINE_ACCOUNT env)' : '';
    console.log(`  ${j.ok ? 'OK ' : 'FAIL'} ${j.label} exit=${j.code ?? 'timeout'} ${Math.round(j.durationMs / 1000)}s${note}`);
    if (!j.ok && note) needsYou.push(`${j.label}: exit ${j.code}${note}`);
  }

  // ---- S4 residual ----
  let after: ScanRow[] = before;
  if (!args.dryRun && !args.skipScan) {
    console.log('S4 re-scan:');
    after = await fullScan();
  }
  const afterCsv = `${OUT}/scan-${runId}-after.csv`;
  writeScanCsv(afterCsv, after);
  const residualSorted = [...after].sort((a, b) => a.merchant.localeCompare(b.merchant) || a.holder.localeCompare(b.holder) || a.date.localeCompare(b.date));
  // Only rewrite residual-queue.csv on real scans — a --skip-scan run has no real "after" snapshot,
  // and overwriting with an empty queue would erase the operator's current state file.
  if (!args.skipScan) {
    writeFileSync(`${OUT}/residual-queue.csv`, [SCAN_CSV_HEADER, ...residualSorted.map(scanCsvLine)].join('\n') + '\n');
  }
  const fixedThisRun = before.filter((r) => !new Set(after.map((x) => x.id)).has(r.id)).length;

  // ---- report ----
  const top = rollupByMerchant(after).slice(0, 20);
  const totalCents = after.reduce((a, r) => a + Math.abs(r.amountCents), 0);
  const report = [
    `# Receipt sweep ${runId}`,
    ``,
    `Mode: ${mode}. Vendors: ${args.vendors.join(', ')}.`,
    ``,
    `## Scan`,
    `- Open receiptless before: ${before.length} | after: ${after.length} (${money(totalCents)})`,
    `- Fixed THIS run: ${fixedThisRun}`,
    `- Since last sweep: fixed ${fixedSinceLast}, new ${newSinceLast}`,
    ``,
    `## Vendor jobs`,
    ...jobs.flatMap((j) => [`### ${j.label} — ${j.ok ? 'OK' : `FAIL (exit ${j.code ?? 'timeout'})`}`, ...j.summaryLines.map((l) => `- ${l}`), j.ok ? '' : '```\n' + j.stdoutTail.slice(-1200) + '\n```']),
    ``,
    `## Needs you`,
    ...(needsYou.length ? needsYou.map((n) => `- [ ] ${n}`) : ['- nothing — fully automatic this week']),
    ``,
    `## Residual queue (top merchants by $)`,
    `| merchant | txns | $ |`,
    `|---|---|---|`,
    ...top.map((t) => `| ${t.merchant} | ${t.n} | ${money(t.cents)} |`),
    ``,
    `Full queue: out/sweep/residual-queue.csv (grouped vendor -> cardholder -> date). Audit: out/receipt-capture-audit.csv.`,
  ].join('\n');
  const reportPath = `${OUT}/report-${runId}.md`;
  writeFileSync(reportPath, report + '\n');

  // A --skip-scan run has no real "after" snapshot (before/after are both the empty S1-skip
  // placeholder) — updating lastScanCsv here would poison the next real run's diff baseline
  // with a zero-row scan, so only the history entry is appended and the pointer stays put.
  if (!args.skipScan) state.lastScanCsv = afterCsv;
  state.history.push({ runId, total: after.length, cents: totalCents });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\nresidual ${after.length} txns ${money(totalCents)} | fixed this run ${fixedThisRun} | report ${reportPath}`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
