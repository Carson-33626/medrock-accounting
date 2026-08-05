// Probe: how does the team actually book Medisca CREDITS / free goods in QuickBooks?
// Carson's description: "many items may be Free — the team sets a cost then a credit at the same
// time to account for the item's value." If that is true there should be paired +/- lines on the
// same bill for the same item. Find out.
//   npx tsx scripts/receipt-capture/_probe-medisca-credits.ts
import '../ramp-split-push/load-env';
import { normalizeItem } from './medisca-gl';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const VENDOR_RE = /medisca/i;
const SINCE = '2023-01-01';

interface QbLine { Description?: string; Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { Id?: string; DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: QbLine[] }

function bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1); }

async function main(): Promise<void> {
  const bills: QbBill[] = [];
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${SINCE}'`);
    bills.push(...rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? '')));
  }

  const negByDesc = new Map<string, number>();
  const zeroByDesc = new Map<string, number>();
  const negByAcct = new Map<string, number>();
  let neg = 0;
  let zero = 0;
  const pairedBills: string[] = [];

  for (const b of bills) {
    const lines = b.Line ?? [];
    for (const l of lines) {
      const amt = l.Amount ?? 0;
      const desc = (l.Description ?? '(empty)').trim();
      if (amt < 0) {
        neg++;
        bump(negByDesc, desc.slice(0, 60));
        bump(negByAcct, l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '(no acct)');
      } else if (amt === 0) {
        zero++;
        bump(zeroByDesc, desc.slice(0, 60));
      }
    }
    // A "cost then credit for the same item" would be a +N and a -N sharing a normalised description.
    for (const l of lines) {
      const amt = l.Amount ?? 0;
      if (amt >= 0) continue;
      const key = normalizeItem(l.Description ?? '');
      const mate = lines.find((o) => (o.Amount ?? 0) === -amt && normalizeItem(o.Description ?? '') === key);
      if (mate) pairedBills.push(`${b.TxnDate} ${b.DocNumber ?? b.Id ?? ''} $${amt.toFixed(2)} :: ${l.Description ?? ''}`);
    }
  }

  console.log(`Medisca QB bills since ${SINCE}: ${bills.length}`);
  console.log(`\nNEGATIVE lines: ${neg}`);
  for (const [d, n] of [...negByDesc].sort((a, b2) => b2[1] - a[1]).slice(0, 20)) console.log(`  ${String(n).padStart(4)}  ${d}`);
  console.log(`  -- accounts --`);
  for (const [a, n] of [...negByAcct].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${a}`);

  console.log(`\nZERO-amount lines: ${zero}`);
  for (const [d, n] of [...zeroByDesc].sort((a, b2) => b2[1] - a[1]).slice(0, 20)) console.log(`  ${String(n).padStart(4)}  ${d}`);

  console.log(`\nPAIRED cost+credit on the SAME item (the "free item" pattern): ${pairedBills.length}`);
  for (const p of pairedBills.slice(0, 20)) console.log(`  ${p}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
