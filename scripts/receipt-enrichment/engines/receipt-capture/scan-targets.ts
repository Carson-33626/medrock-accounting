// Ramp targeting sweep — READ-ONLY, never writes to Ramp.
//
// Answers two standing questions:
//   1. what is the current receiptless residual for each vendor we already automate?
//   2. which uncovered merchants are worth automating next?
//
// Usage (from web/):
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/scan-targets.ts
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/scan-targets.ts --top 40
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/scan-targets.ts --all
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/scan-targets.ts --merchant Indeed     # drill into one merchant
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/scan-targets.ts --csv out/my-scan.csv
//
// Columns that drive the automation call:
//   last90          txns in the last 90 days. High => an ongoing STREAM worth automating.
//                   Near zero => a decaying BACKLOG; automation pays back once and stops.
//   cardholders     distinct cardholders. 1-2 => one login/portal to script.
//   amt_uniq%       distinct amounts / txns. Near 100% => amount is a near-unique match key
//                   (easy, reliable order<->charge pairing). Low => needs date+order-id matching.
//   entities        FL/TN/TX spread. Multi-entity needs the pooled matcher (see walmart-enrich).
import '../ramp-split-push/load-env';
import { rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import { scanEntity, type ScanRow } from './sweep-scan';
import { writeFileSync } from 'node:fs';
import { RC } from '../../paths';

interface Coverage {
  vendor: string;
  test: (merchant: string) => boolean;
}

// Merchant patterns for pipelines that already exist. Deliberately tight: "Amazon Web Services"
// and "Amz Hyper" are NOT the Amazon retail pipeline and must stay in the uncovered list.
const COVERED: Coverage[] = [
  { vendor: 'uline', test: (m) => /\buline\b/i.test(m) },
  { vendor: 'toprx', test: (m) => /\btoprx\b/i.test(m) },
  { vendor: 'walmart', test: (m) => /\bwalmart\b/i.test(m) },
  { vendor: 'sams', test: (m) => /\bsam'?s\s*club\b/i.test(m) },
  { vendor: 'amazon', test: (m) => /^amazon$/i.test(m.trim()) || /amazon\.com|amzn\s*mktp/i.test(m) },
];

function coverageOf(merchant: string): string {
  for (const c of COVERED) if (c.test(merchant)) return c.vendor;
  return '';
}

interface Agg {
  merchant: string;
  txns: number;
  cents: number;
  entities: Set<string>;
  holders: Set<string>;
  amounts: Set<number>;
  ages: number[];
  coverage: string;
}

interface Args {
  top: number;
  all: boolean;
  merchant: string | null;
  csv: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : null;
  };
  const topRaw = get('--top');
  const parsedTop = topRaw === null ? 25 : Number.parseInt(topRaw, 10);
  return {
    top: Number.isFinite(parsedTop) && parsedTop > 0 ? parsedTop : 25,
    all: argv.includes('--all'),
    merchant: get('--merchant'),
    csv: get('--csv') ?? `${RC.out}/target-scan.csv`,
  };
}

function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 9999 : Math.floor((now - t) / 86_400_000);
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function collect(): Promise<ScanRow[]> {
  const all: ScanRow[] = [];
  for (const e of ALL_ENTITIES) {
    const token = await rampToken(e, 'transactions:read');
    const rows = await scanEntity(e, token);
    all.push(...rows);
    const cents = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
    console.log(`${e}: ${rows.length} txns  $${money(cents)}`);
  }
  return all;
}

function aggregate(rows: ScanRow[], now: number): Agg[] {
  const by = new Map<string, Agg>();
  for (const r of rows) {
    const key = r.merchant || '(blank)';
    let a = by.get(key);
    if (a === undefined) {
      a = { merchant: key, txns: 0, cents: 0, entities: new Set(), holders: new Set(), amounts: new Set(), ages: [], coverage: coverageOf(key) };
      by.set(key, a);
    }
    a.txns++;
    a.cents += Math.abs(r.amountCents);
    a.entities.add(r.entity);
    a.holders.add(r.holder);
    a.amounts.add(Math.abs(r.amountCents));
    a.ages.push(ageDays(r.date, now));
  }
  return [...by.values()].sort((x, y) => y.cents - x.cents);
}

function last90(a: Agg): number {
  return a.ages.filter((d) => d <= 90).length;
}

function uniqPct(a: Agg): number {
  return Math.round((a.amounts.size / a.txns) * 100);
}

function drill(rows: ScanRow[], needle: string, now: number): void {
  const hits = rows.filter((r) => r.merchant.toLowerCase().includes(needle.toLowerCase()));
  if (hits.length === 0) {
    console.log(`\nNo open receiptless txns matching "${needle}".`);
    return;
  }
  const cents = hits.reduce((s, r) => s + Math.abs(r.amountCents), 0);
  console.log(`\n=== ${needle} — ${hits.length} txns / $${money(cents)} ===`);
  console.log('entity  date        amount  age  cardholder            txn_id');
  for (const r of hits.sort((x, y) => x.date.localeCompare(y.date))) {
    console.log(
      `${r.entity.padEnd(7)} ${r.date.slice(0, 10)} ${money(Math.abs(r.amountCents)).padStart(9)} ${String(ageDays(r.date, now)).padStart(4)}  ${r.holder.slice(0, 20).padEnd(21)} ${r.id}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await collect();
  const now = Date.now();
  const aggs = aggregate(rows, now);
  const total = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
  console.log(`\nTOTAL: ${rows.length} txns  $${money(total)}  across ${aggs.length} merchants`);

  if (args.merchant !== null) {
    drill(rows, args.merchant, now);
    return;
  }

  const header = 'merchant,coverage,txns,dollars,entities,cardholders,distinct_amounts,amt_uniq_pct,last_90d,newest_days,oldest_days';
  const lines = [header];
  for (const a of aggs) {
    const sorted = [...a.ages].sort((p, q) => p - q);
    lines.push([
      csvCell(a.merchant),
      a.coverage || 'UNCOVERED',
      String(a.txns),
      money(a.cents),
      csvCell([...a.entities].sort().join('/')),
      String(a.holders.size),
      String(a.amounts.size),
      String(uniqPct(a)),
      String(last90(a)),
      String(sorted[0] ?? -1),
      String(sorted[sorted.length - 1] ?? -1),
    ].join(','));
  }
  writeFileSync(args.csv, lines.join('\n'));

  const covered = aggs.filter((a) => a.coverage !== '');
  const byVendor = new Map<string, Agg[]>();
  for (const a of covered) byVendor.set(a.coverage, [...(byVendor.get(a.coverage) ?? []), a]);
  console.log('\n=== ALREADY AUTOMATED — current residual ===');
  console.log('vendor         txns          $  entities   last90');
  const ranked = [...byVendor.entries()].sort((x, y) => y[1].reduce((s, a) => s + a.cents, 0) - x[1].reduce((s, a) => s + a.cents, 0));
  for (const [vendor, list] of ranked) {
    const t = list.reduce((s, a) => s + a.txns, 0);
    const c = list.reduce((s, a) => s + a.cents, 0);
    const l90 = list.reduce((s, a) => s + last90(a), 0);
    const ents = [...new Set(list.flatMap((a) => [...a.entities]))].sort().join('/');
    console.log(`${vendor.padEnd(13)} ${String(t).padStart(4)} ${money(c).padStart(10)}  ${ents.padEnd(9)} ${String(l90).padStart(5)}`);
  }
  const covT = covered.reduce((s, a) => s + a.txns, 0);
  const covC = covered.reduce((s, a) => s + a.cents, 0);
  console.log(`${'TOTAL'.padEnd(13)} ${String(covT).padStart(4)} ${money(covC).padStart(10)}`);

  const uncovered = aggs.filter((a) => a.coverage === '');
  const shown = args.all ? uncovered : uncovered.slice(0, args.top);
  const unT = uncovered.reduce((s, a) => s + a.txns, 0);
  const unC = uncovered.reduce((s, a) => s + a.cents, 0);
  console.log(`\n=== UNCOVERED — ${unT} txns / $${money(unC)} across ${uncovered.length} merchants (showing ${shown.length}) ===`);
  console.log('merchant                             txns          $  ents      hold  amt_uniq  last90');
  for (const a of shown) {
    console.log(
      `${a.merchant.slice(0, 35).padEnd(36)} ${String(a.txns).padStart(4)} ${money(a.cents).padStart(10)}  ${[...a.entities].sort().join('/').padEnd(8)} ${String(a.holders.size).padStart(4)}  ${`${uniqPct(a)}%`.padStart(7)}  ${String(last90(a)).padStart(5)}`,
    );
  }
  console.log(`\nFull CSV: ${args.csv}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
