// Probe: answer Carson's open question — is a Stir-Bar Positioner/Retriever lab SUPPLIES (inventory)
// or lab EXPENSE? Show the full account names in play, then every reusable lab-hardware item she has
// coded, so the precedent decides it rather than my guess.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-medisca-labhardware.ts
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';

const VENDOR_RE = /medisca/i;
const SINCE = '2023-01-01';

// Reusable tools/hardware, as opposed to consumed ingredients or disposable packaging.
const HARDWARE_RE = /stir|spatula|beaker|mortar|pestle|funnel|forcep|tweezer|scoop|sieve|thermometer|magnet|rack|stand|clamp|holder|positioner|retriever|graduate|cylinder|flask|balance|scale|mixer|blade|capsule machine|tamper|plate|tile/i;

interface QbLine { Description?: string; Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { Id?: string; DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: QbLine[] }

interface Coded { date: string; entity: Entity; desc: string; account: string; full: string; amount: number }

async function main(): Promise<void> {
  const coded: Coded[] = [];
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const desc = (l.Description ?? '').trim();
        if (!acct || desc === '') continue;
        coded.push({ date: b.TxnDate ?? '', entity, desc, account: acct.split(' ')[0], full: acct, amount: l.Amount ?? 0 });
      }
    }
  }

  console.log('=== every account she uses for Medisca, with its FULL QuickBooks name ===');
  const byAcct = new Map<string, { full: string; n: number; total: number }>();
  for (const c of coded) {
    const e = byAcct.get(c.account) ?? { full: c.full, n: 0, total: 0 };
    e.n++; e.total += c.amount;
    byAcct.set(c.account, e);
  }
  for (const [code, e] of [...byAcct].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${code.padEnd(9)} ${String(e.n).padStart(5)} lines  $${e.total.toFixed(2).padStart(12)}  ${e.full}`);
  }

  console.log('\n=== reusable lab hardware / tools she has coded ===');
  const hw = coded.filter((c) => HARDWARE_RE.test(c.desc));
  const byNorm = new Map<string, { acct: Map<string, number>; sample: string; last: string; total: number }>();
  for (const c of hw) {
    const n = c.desc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(lot|exp|qty)\b.*$/, '').trim().slice(0, 45);
    const e = byNorm.get(n) ?? { acct: new Map<string, number>(), sample: c.desc, last: c.date, total: 0 };
    e.acct.set(c.account, (e.acct.get(c.account) ?? 0) + 1);
    if (c.date > e.last) e.last = c.date;
    e.total += c.amount;
    byNorm.set(n, e);
  }
  for (const [, e] of [...byNorm].sort((x, y) => y[1].last.localeCompare(x[1].last))) {
    const accts = [...e.acct].sort((x, y) => y[1] - x[1]).map(([a, n]) => `${a}x${n}`).join(' ');
    console.log(`  ${accts.padEnd(24)} last ${e.last}  $${e.total.toFixed(2).padStart(10)}  "${e.sample.replace(/\s+/g, ' ').slice(0, 66)}"`);
  }

  console.log('\n=== what lands in 1220.20 (the lab-supplies bucket) ===');
  const lab = coded.filter((c) => c.account === '1220.20');
  const labItems = new Map<string, number>();
  for (const c of lab) {
    const n = c.desc.replace(/\s+/g, ' ').slice(0, 58);
    labItems.set(n, (labItems.get(n) ?? 0) + 1);
  }
  for (const [d, n] of [...labItems].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${String(n).padStart(3)}  ${d}`);

  console.log('\n=== what lands in 6200.75 (the lab-expense bucket) ===');
  const exp = coded.filter((c) => c.account === '6200.75');
  const expItems = new Map<string, number>();
  for (const c of exp) {
    const n = c.desc.replace(/\s+/g, ' ').slice(0, 58);
    expItems.set(n, (expItems.get(n) ?? 0) + 1);
  }
  for (const [d, n] of [...expItems].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${String(n).padStart(3)}  ${d}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
