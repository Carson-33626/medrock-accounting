// QB-side vendor ranking — READ-ONLY, never writes.
//
// The complement to scan-targets.ts. That tool reads RAMP, so it can only see vendors that spend
// on a card; every vendor paid by ACH, check or bank autopay is invisible to it. Letco Medical
// (Fagron) is the case that proved the blind spot: ZERO Ramp txns, but 218 hand-keyed QuickBooks
// documents worth $686k in 2026 alone.
//
// This ranks vendors by the thing the portal->QB-Bill program is meant to remove: how many
// documents the accountant keys by hand. Dollars are shown but are NOT the sort key — a vendor
// with 200 small bills costs more keying time than one with 3 large ones.
//
// Usage (from web/):
//   npx tsx scripts/receipt-capture/scan-bill-vendors.ts
//   npx tsx scripts/receipt-capture/scan-bill-vendors.ts --since 2025-01-01 --top 40
//   npx tsx scripts/receipt-capture/scan-bill-vendors.ts --all --csv out/bill-vendors.csv
//
// Columns:
//   docs        total Bill + Purchase documents = keying events. THE ranking signal.
//   /mo         documents per month over the window — is this an ongoing stream?
//   bills/purch Bill = entered from an invoice (hand-keyed). Purchase = direct card/cash expense,
//               which is where a Ramp sync lands. A vendor that is nearly all Bills is a pure
//               manual-entry vendor and the best automation candidate.
//   last90      documents in the last 90 days — dormant vendors rank themselves down.
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { writeFileSync } from 'node:fs';

interface QBRef { value: string; name?: string }
interface QBDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  VendorRef?: QBRef;
  EntityRef?: QBRef;
}

interface Args { since: string; top: number; all: boolean; csv: string }

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : null;
  };
  const topRaw = get('--top');
  const parsedTop = topRaw === null ? 30 : Number.parseInt(topRaw, 10);
  return {
    since: get('--since') ?? '2026-01-01',
    top: Number.isFinite(parsedTop) && parsedTop > 0 ? parsedTop : 30,
    all: argv.includes('--all'),
    csv: get('--csv') ?? 'scripts/receipt-capture/out/bill-vendors.csv',
  };
}

// Group cross-entity spellings of one vendor together where it is safe to do so: QB carries the
// same supplier as "Letco Medical, LLC - Autopay" in FL/TN and plain "Letco" in TX. Stripping
// payment-method and entity-type suffixes merges most of those. It will NOT merge every variant —
// the raw names are kept on the row so a split vendor is visible rather than silently wrong.
function vendorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*-\s*autopay(\s*cc)?\b/g, '')
    .replace(/\b(llc|inc|corp|corporation|co|company|ltd)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

interface Agg {
  key: string;
  names: Set<string>;
  entities: Set<Entity>;
  bills: number;
  purchases: number;
  cents: number;
  ages: number[];
}

function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 99999 : Math.floor((now - t) / 86_400_000);
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const by = new Map<string, Agg>();
  let scanned = 0;

  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    for (const kind of ['Bill', 'Purchase'] as const) {
      const docs = await qbQueryAll<QBDoc>(loc, kind, `WHERE TxnDate >= '${args.since}'`);
      for (const d of docs) {
        const name = (d.VendorRef?.name ?? d.EntityRef?.name ?? '').trim();
        if (name === '') continue;
        scanned++;
        const key = vendorKey(name);
        let a = by.get(key);
        if (a === undefined) {
          a = { key, names: new Set(), entities: new Set(), bills: 0, purchases: 0, cents: 0, ages: [] };
          by.set(key, a);
        }
        a.names.add(name);
        a.entities.add(entity);
        if (kind === 'Bill') a.bills++; else a.purchases++;
        a.cents += Math.round((d.TotalAmt ?? 0) * 100);
        if (d.TxnDate !== undefined) a.ages.push(ageDays(d.TxnDate, now));
      }
    }
    console.log(`[${entity}] scanned`);
  }

  const windowDays = Math.max(1, ageDays(args.since, now));
  const months = windowDays / 30.44;

  const rows = [...by.values()]
    .map((a) => ({
      agg: a,
      docs: a.bills + a.purchases,
      last90: a.ages.filter((d) => d <= 90).length,
      perMonth: (a.bills + a.purchases) / months,
    }))
    .sort((x, y) => y.docs - x.docs);

  const totalDocs = rows.reduce((s, r) => s + r.docs, 0);
  const totalCents = rows.reduce((s, r) => s + r.agg.cents, 0);
  console.log(`\nQB documents on/after ${args.since}: ${scanned} raw, ${totalDocs} attributed, $${money(totalCents)} across ${rows.length} vendors`);
  console.log(`window = ${windowDays} days (~${months.toFixed(1)} months)\n`);

  const header = 'vendor,raw_names,entities,docs,bills,purchases,dollars,docs_per_month,last_90d,newest_days,oldest_days';
  const lines = [header];
  for (const r of rows) {
    const sorted = [...r.agg.ages].sort((p, q) => p - q);
    lines.push([
      csvCell([...r.agg.names][0] ?? r.agg.key),
      csvCell([...r.agg.names].join(' | ')),
      csvCell([...r.agg.entities].sort().join('/')),
      String(r.docs),
      String(r.agg.bills),
      String(r.agg.purchases),
      money(r.agg.cents),
      r.perMonth.toFixed(1),
      String(r.last90),
      String(sorted[0] ?? -1),
      String(sorted[sorted.length - 1] ?? -1),
    ].join(','));
  }
  writeFileSync(args.csv, lines.join('\n'));

  const shown = args.all ? rows : rows.slice(0, args.top);
  console.log('vendor                                 docs   /mo  bills  purch          $  ents      last90');
  for (const r of shown) {
    const name = ([...r.agg.names][0] ?? r.agg.key).slice(0, 36);
    console.log(
      `${name.padEnd(37)} ${String(r.docs).padStart(5)} ${r.perMonth.toFixed(1).padStart(5)} ${String(r.agg.bills).padStart(6)} ${String(r.agg.purchases).padStart(6)} ${money(r.agg.cents).padStart(11)}  ${[...r.agg.entities].sort().join('/').padEnd(9)} ${String(r.last90).padStart(5)}`,
    );
  }
  console.log(`\nFull CSV: ${args.csv}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
