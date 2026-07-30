// web/scripts/receipt-capture/run-sweep.ts
// THE one-command receipt sweep (spec 2026-07-28): scan everything open, run every vendor
// pipeline that has access, re-scan, and emit report + residual queue. LIVE BY DEFAULT with no
// caps (Carson 2026-07-28) — --dry-run opts down; every underlying runner keeps its own gates.
//   npx tsx scripts/receipt-capture/run-sweep.ts [--dry-run] [--vendor toprx,uline,amazon,walmart,sams,amazon-csv] [--limit N] [--skip-scan]
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
import { SAMS } from '../walmart-enrich/retailer-profile';
import { ALL_ENTITIES } from '../ramp-split-push/types';

const OUT = 'scripts/receipt-capture/out/sweep';
const STATE_PATH = `${OUT}/state.json`;
const ULINE_STATE_DIR = 'scripts/receipt-capture/.state';
const WM_CDP = process.env.WM_CDP_URL ?? 'http://127.0.0.1:9222';
const ALL_VENDORS = ['toprx', 'uline', 'amazon', 'walmart', 'sams', 'amazon-csv'] as const;
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
  // Walmart and Sam's share ONE Chrome profile and one CDP port — the same sign-in serves both sites,
  // and their extract children run sequentially, so there is no contention.
  if (args.vendors.includes('walmart') && !wmCdp.reachable) needsYou.push(`Walmart extract skipped (${wmCdp.detail}). Launch: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\wm-chrome-profile and sign into walmart.com`);
  if (args.vendors.includes('sams') && !wmCdp.reachable) needsYou.push(`Sam's Club extract skipped (${wmCdp.detail}). Launch: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\wm-chrome-profile and sign into samsclub.com`);
  // Name the CURRENT extractor (run-extract-txns.ts) and the invoice fetch. This string is the one piece of
  // operator guidance read every week; when it named the retired run-extract.ts, the caches it produced were
  // not the ones the attach pairs from, and confident pairs went unattached for two sweeps.
  if (args.vendors.includes('amazon-csv')) needsYou.push('Amazon-CSV extract is always manual: sign ONE Business login into a CDP Chrome (--user-data-dir=C:\\amz-chrome-profile), then run scripts/amazon-csv-enrich/run-extract-txns.ts --account FL (then TN, TX), then scripts/amazon-csv-enrich/fetch-invoices.ts to cache the invoice PDFs this sweep attaches');
  console.log(`preflight: toprx[${toprx.detail}] uline[${uline.detail}] walmart-cdp[${wmCdp.reachable ? 'up' : 'down'}]`);

  // ---- S1 scan ----
  let before: ScanRow[] = [];
  if (!args.skipScan) {
    console.log('S1 scan:');
    before = await fullScan();
    writeScanCsv(`${OUT}/scan-${runId}-before.csv`, before);
  }
  // A --skip-scan run's `before` is the empty S1-skip placeholder, not a real scan — diffing it
  // against the last real baseline would report every previously-open txn as "fixed" and nothing
  // as "new", which is noise, not signal. Suppress the computation entirely rather than compute
  // and then hide a wrong number.
  let fixedSinceLast: number | null = null;
  let newSinceLast: number | null = null;
  if (!args.skipScan) {
    const prevIds = readScanIds(state.lastScanCsv ?? '');
    const beforeIds = new Set(before.map((r) => r.id));
    fixedSinceLast = [...prevIds].filter((id) => !beforeIds.has(id)).length;
    newSinceLast = before.filter((r) => !prevIds.has(r.id)).length;
  }

  // ---- S2/S3 vendor jobs (sequential) ----
  const lim = String(args.limit);
  const live = (base: string[]): string[] => (args.dryRun ? base : [...base, '--live']);
  const want = (v: Vendor): boolean => args.vendors.includes(v);

  // walmart-attach and amazon-csv-attach treat `--cap 0` as UNCAPPED (their own `cap > 0` gate
  // disables the check entirely at 0), the OPPOSITE of every `--limit`-based runner here, where 0
  // correctly means zero writes. An explicit `--limit 0` on a live sweep must not turn into an
  // unbounded live cap for these two children — force them dry instead and flag why in the report.
  const cap0Uncapped = args.limit === 0 && !args.dryRun;
  const attachLive = (base: string[]): string[] => (cap0Uncapped ? base : live(base));

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
      if (cap0Uncapped) console.log('  walmart-attach: --limit 0 requested, but --cap 0 means UNCAPPED for this runner — forcing dry-run instead (limit_0)');
      jobs.push(await runChild(cap0Uncapped ? 'walmart-attach (limit_0)' : 'walmart-attach', attachLive(['scripts/walmart-enrich/run-cdp-split.ts', '--cap', args.dryRun ? '0' : lim])));
    } else {
      needsYou.push('Walmart attach skipped: no extraction cache yet (needs one CDP extract run)');
    }
  }
  if (want('sams')) {
    // Same runner as Walmart, switched by --retailer; only the extractor is Sam's-specific.
    if (wmCdp.reachable) {
      const extract = await runChild('sams-extract', ['scripts/walmart-enrich/run-cdp-sams.ts']);
      jobs.push(extract);
      // Exit 5 is the extractor's "I stopped early rather than leave silent gaps" signal — a bot
      // challenge or a run of detail failures. That is an operator action (clear it by hand in the
      // Chrome window), not a crash, so say so instead of leaving a bare non-zero exit in the report.
      if (extract.code === 5) needsYou.push("Sam's extract stopped early — check the Chrome window for a bot challenge, clear it by hand, then re-run. The cache is write-through, so a re-run resumes where it stopped.");
    }
    if (existsSync(SAMS.cacheFile)) {
      if (cap0Uncapped) console.log('  sams-attach: --limit 0 requested, but --cap 0 means UNCAPPED for this runner — forcing dry-run instead (limit_0)');
      jobs.push(await runChild(cap0Uncapped ? 'sams-attach (limit_0)' : 'sams-attach', attachLive(['scripts/walmart-enrich/run-cdp-split.ts', '--retailer', 'sams', '--cap', args.dryRun ? '0' : lim])));
    } else {
      needsYou.push("Sam's attach skipped: no extraction cache yet (needs one CDP extract run)");
    }
  }
  if (want('amazon-csv')) {
    const root = 'scripts/amazon-csv-enrich/out';
    // Gate on transactions.csv — the report run-attach actually pairs from. The old charges.json gate
    // could skip the attach entirely on a machine that had only ever run the current extractor.
    const hasCache = existsSync(root) && readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(root, d.name, 'transactions.csv')));
    if (hasCache) {
      if (cap0Uncapped) console.log('  amazon-csv-attach: --limit 0 requested, but --cap 0 means UNCAPPED for this runner — forcing dry-run instead (limit_0)');
      jobs.push(await runChild(cap0Uncapped ? 'amazon-csv-attach (limit_0)' : 'amazon-csv-attach', attachLive(['scripts/amazon-csv-enrich/run-attach.ts', '--cap', args.dryRun ? '0' : lim])));
    }
    else needsYou.push('Amazon-CSV attach skipped: no transactions.csv cached yet (run run-extract-txns.ts --account <ENT> per Business account first)');
  }

  for (const j of jobs) {
    const note = j.label.startsWith('uline') && j.code === 2 ? ' (session expired - re-run bootstrap)'
      : j.label.startsWith('uline') && j.code === 3 ? ' (account identity mismatch - check ULINE_ACCOUNT env)'
      : j.label.startsWith('uline') && j.code === 4 ? ' (consumed-invoice registry corrupt - hard stop, inspect out/uline-consumed.json)' : '';
    console.log(`  ${j.ok ? 'OK ' : 'FAIL'} ${j.label} exit=${j.code ?? 'timeout'} ${Math.round(j.durationMs / 1000)}s${note}`);
    if (!j.ok && note) needsYou.push(`${j.label}: exit ${j.code}${note}`);
  }

  // ---- S4 residual ----
  let after: ScanRow[] = before;
  const willRescan = !args.dryRun && !args.skipScan;
  if (willRescan) {
    // Ramp's own indexing of a just-attached receipt/split lags a few seconds behind the write
    // call in practice — an immediate re-scan can still see a txn as receipt-less even though the
    // attach succeeded moments ago. Give the indexing a head start before reading it back.
    console.log('S4 pausing 15s for Ramp receipt indexing to catch up before re-scan...');
    await new Promise((r) => setTimeout(r, 15_000));
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
  const afterIds = new Set(after.map((x) => x.id));
  const fixedThisRun = before.filter((r) => !afterIds.has(r.id)).length;

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
    ...(args.skipScan ? [] : [`- Since last sweep: fixed ${fixedSinceLast}, new ${newSinceLast}`]),
    ...(willRescan ? [`- Note: fixed-this-run and residual counts may lag Ramp's indexing of just-attached receipts; re-run with --skip-scan omitted later to confirm.`] : []),
    ``,
    `## Vendor jobs`,
    ...jobs.flatMap((j) => [`### ${j.label} — ${j.ok ? 'OK' : `FAIL (exit ${j.code ?? 'timeout'})`}`, ...j.summaryLines.map((l) => `- ${l}`), j.ok ? '' : '```\n' + j.stdoutTail.slice(-1200) + '\n```']),
    ``,
    `## Needs you`,
    ...(needsYou.length ? needsYou.flatMap((n) => n.split('\n').map((line) => `- [ ] ${line}`)) : ['- nothing — fully automatic this week']),
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
  // placeholder) — updating lastScanCsv here would poison the next real run's diff baseline with
  // a zero-row scan, and appending a {total: 0} history entry would do the same to the history
  // trend, so both are skipped entirely for a --skip-scan run.
  if (!args.skipScan) {
    state.lastScanCsv = afterCsv;
    state.history.push({ runId, total: after.length, cents: totalCents });
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\nresidual ${after.length} txns ${money(totalCents)} | fixed this run ${fixedThisRun} | report ${reportPath}`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
