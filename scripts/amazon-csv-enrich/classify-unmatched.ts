// READ-ONLY: pull full merchant detail for the un-enriched April/May Amazon txns and bucket them, to tell
// non-Business Amazon (Prime/AWS/Kindle/digital — no itemized receipt) from Business orders we simply
// haven't exported (a different Amazon login) — the latter are still reachable by the tooling.
import './../ramp-split-push/load-env';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { getUnenrichedAmazonTxns } from './client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

function argVal(f: string, d: string): string { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; }

interface RawTxn { id: string; merchant_name: string | null; merchant_descriptor?: string | null; sk_category_name?: string | null; user_transaction_time?: string; amount: number; }

function bucket(name: string, desc: string): string {
  const s = `${name} ${desc}`.toLowerCase();
  if (/aws|web services/.test(s)) return 'AWS';
  if (/prime|kindle|music|video|audible|digital|channels/.test(s)) return 'Prime/Digital';
  if (/amazon\s*business|amzn.*biz|amazon business/.test(s)) return 'Amazon Business';
  if (/mktp|marketplace|amzn mktp|amazon\.com/.test(s)) return 'Amazon.com/Mktp';
  return 'Amazon (other)';
}

async function main(): Promise<void> {
  const from = argVal('--from', '2026-04-01'), to = argVal('--to', '2026-05-31');
  const pages = Number(argVal('--pages', '260')) || 260;
  const buckets = new Map<string, { n: number; amt: number; samples: string[] }>();
  for (const e of ALL_ENTITIES) {
    const token = await rampToken(e, 'transactions:read');
    const win = (await getUnenrichedAmazonTxns(e, token, pages)).filter((t) => t.date >= from && t.date <= to);
    for (const t of win) {
      const { body } = await rampGet<RawTxn>(e, `/transactions/${t.id}`, token);
      const desc = body.merchant_descriptor ?? '';
      const key = bucket(body.merchant_name ?? '', desc);
      const b = buckets.get(key) ?? { n: 0, amt: 0, samples: [] };
      b.n++; b.amt += body.amount;
      if (b.samples.length < 4) b.samples.push(`${e} ${t.date} $${body.amount.toFixed(2)} "${body.merchant_name}" desc="${desc}" cat="${body.sk_category_name ?? ''}"`);
      buckets.set(key, b);
    }
  }
  console.log(`\n=== April/May un-enriched Amazon by merchant type ===`);
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`\n${k}: ${v.n} txns ($${v.amt.toFixed(2)})`);
    for (const s of v.samples) console.log(`    ${s}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
