// Probe: for each of the 6 distinct items blocking a Medisca draft, show the accountant's ACTUAL
// history — every coded instance with its date, entity and account, plus the nearest similar items
// for the ones she has never coded. This is the evidence Carson needs to rule on each item.
//   npx tsx scripts/receipt-capture/_probe-medisca-blockers.ts
import '../ramp-split-push/load-env';
import { normalizeItem } from './medisca-gl';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const VENDOR_RE = /medisca/i;
const SINCE = '2023-01-01';

// The exact Ramp memos that blocked a draft, plus a loose token to hunt near-misses with.
const BLOCKERS: { memo: string; hunt: RegExp }[] = [
  { memo: 'Bimatoprost (Frozen)', hunt: /bimatoprost/i },
  { memo: 'Tranexamic Acid, USP', hunt: /tranexamic/i },
  { memo: 'Dispenser, MD Syringe Airless 10mL, 0.15mL, w/view window Qty:5', hunt: /dispenser|syringe/i },
  { memo: 'Estradiol, USP (Hemihydrate) (Micronized)', hunt: /estradiol/i },
  { memo: 'Stir-Bar Positioner/Retriever 12" Lot:228149/A Exp:N/A Qty:2', hunt: /stir.?bar|positioner|retriever/i },
];

interface QbLine { Description?: string; Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { Id?: string; DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: QbLine[] }

interface Coded { date: string; doc: string; entity: Entity; desc: string; account: string; amount: number }

async function main(): Promise<void> {
  const coded: Coded[] = [];
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const desc = (l.Description ?? '').trim();
        if (!acct || desc === '') continue;
        coded.push({
          date: b.TxnDate ?? '', doc: b.DocNumber ?? b.Id ?? '', entity,
          desc, account: acct.split(' ')[0], amount: l.Amount ?? 0,
        });
      }
    }
  }
  console.log(`corpus: ${coded.length} coded Medisca lines since ${SINCE}\n`);

  for (const b of BLOCKERS) {
    const key = normalizeItem(b.memo);
    console.log('='.repeat(100));
    console.log(`BLOCKER: ${b.memo}`);
    console.log(`  normalised -> "${key}"`);

    const exact = coded.filter((c) => normalizeItem(c.desc) === key).sort((x, y) => x.date.localeCompare(y.date));
    if (exact.length > 0) {
      console.log(`\n  EXACT history (${exact.length}):`);
      for (const c of exact) {
        console.log(`    ${c.date}  ${c.entity}  ${c.doc.padEnd(10)} ${c.account.padEnd(8)} $${c.amount.toFixed(2).padStart(9)}`);
      }
    } else {
      console.log('\n  EXACT history: NONE — she has never coded this exact item');
    }

    const near = coded.filter((c) => b.hunt.test(c.desc) && normalizeItem(c.desc) !== key);
    const byNorm = new Map<string, { account: Map<string, number>; sample: string; last: string }>();
    for (const c of near) {
      const n = normalizeItem(c.desc);
      const e = byNorm.get(n) ?? { account: new Map<string, number>(), sample: c.desc, last: c.date };
      e.account.set(c.account, (e.account.get(c.account) ?? 0) + 1);
      if (c.date > e.last) e.last = c.date;
      byNorm.set(n, e);
    }
    if (byNorm.size > 0) {
      console.log(`\n  NEAR-MISS items she HAS coded (${byNorm.size} distinct):`);
      for (const [n, e] of [...byNorm].sort((x, y) => y[1].last.localeCompare(x[1].last)).slice(0, 15)) {
        const accts = [...e.account].sort((x, y) => y[1] - x[1]).map(([a, c2]) => `${a}x${c2}`).join(' ');
        console.log(`    ${accts.padEnd(26)} last ${e.last}  "${e.sample.slice(0, 62)}"`);
        console.log(`      norm: "${n}"`);
      }
    } else {
      console.log('\n  NEAR-MISS items: none matched the hunt pattern');
    }
    console.log('');
  }

  // The blank line on TN draft 04233232: what does she code the third glove size to?
  console.log('='.repeat(100));
  console.log('BLANK-MEMO context — every glove line she has coded:');
  const gloves = coded.filter((c) => /glove/i.test(c.desc));
  const gAcct = new Map<string, number>();
  for (const c of gloves) gAcct.set(c.account, (gAcct.get(c.account) ?? 0) + 1);
  for (const [a, n] of [...gAcct].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${a}`);
  console.log(`  (${gloves.length} glove lines total; most recent below)`);
  for (const c of gloves.sort((x, y) => y.date.localeCompare(x.date)).slice(0, 6)) {
    console.log(`    ${c.date} ${c.entity} ${c.account} $${c.amount.toFixed(2)} "${c.desc.slice(0, 70)}"`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
