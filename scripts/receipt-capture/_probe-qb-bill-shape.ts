// Diagnostic: how does the accountant actually CODE a given vendor's Bills today? Dumps line
// structure, GL accounts, class/location and item-vs-account detail so a generated Bill can match
// her existing pattern instead of inventing one. READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-qb-bill-shape.ts "Letco"
import '../ramp-split-push/load-env';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const NEEDLE = (process.argv[2] ?? 'Letco').toLowerCase();
const SINCE = process.argv[3] ?? '2026-01-01';

interface QBRef { value: string; name?: string }
interface QBLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QBRef; ClassRef?: QBRef; CustomerRef?: QBRef; BillableStatus?: string };
  ItemBasedExpenseLineDetail?: { ItemRef?: QBRef; ClassRef?: QBRef; Qty?: number; UnitPrice?: number };
}
interface QBBill {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  VendorRef?: QBRef;
  APAccountRef?: QBRef;
  DepartmentRef?: QBRef;
  SalesTermRef?: QBRef;
  PrivateNote?: string;
  Line?: QBLine[];
}

function money(n: number | undefined): string {
  return (n ?? 0).toFixed(2);
}

async function main(): Promise<void> {
  console.log(`Bill shape for "${NEEDLE}" since ${SINCE}\n`);

  const accountTally = new Map<string, { lines: number; total: number }>();
  const detailTypes = new Map<string, number>();
  const lineCounts: number[] = [];
  let billCount = 0;
  let withDocNumber = 0;
  const samples: QBBill[] = [];

  for (const entity of ALL_ENTITIES) {
    const loc = ENTITY_TO_QB_LOCATION[entity];
    const bills = (await qbQueryAll<QBBill>(loc, 'Bill', `WHERE TxnDate >= '${SINCE}'`))
      .filter((b) => (b.VendorRef?.name ?? '').toLowerCase().includes(NEEDLE));
    for (const b of bills) {
      billCount++;
      if ((b.DocNumber ?? '') !== '') withDocNumber++;
      const lines = b.Line ?? [];
      lineCounts.push(lines.length);
      for (const l of lines) {
        detailTypes.set(l.DetailType ?? '?', (detailTypes.get(l.DetailType ?? '?') ?? 0) + 1);
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef;
        const item = l.ItemBasedExpenseLineDetail?.ItemRef;
        const label = acct ? `ACCT ${acct.name ?? acct.value}` : item ? `ITEM ${item.name ?? item.value}` : '(none)';
        const t = accountTally.get(label) ?? { lines: 0, total: 0 };
        t.lines++;
        t.total += l.Amount ?? 0;
        accountTally.set(label, t);
      }
      if (samples.length < 3 && lines.length > 0) samples.push(b);
    }
    if (bills.length > 0) console.log(`[${entity}] ${bills.length} bills`);
  }

  console.log(`\ntotal bills: ${billCount} | with a DocNumber: ${withDocNumber} (${billCount > 0 ? Math.round((withDocNumber / billCount) * 100) : 0}%)`);
  const avgLines = lineCounts.length > 0 ? lineCounts.reduce((a, b) => a + b, 0) / lineCounts.length : 0;
  console.log(`lines per bill: avg ${avgLines.toFixed(1)}, min ${Math.min(...lineCounts)}, max ${Math.max(...lineCounts)}`);
  console.log(`line detail types: ${[...detailTypes.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  console.log('\n=== GL accounts / items used ===');
  for (const [label, t] of [...accountTally.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${label.padEnd(52)} ${String(t.lines).padStart(5)} lines  $${money(t.total).padStart(12)}`);
  }

  console.log('\n=== sample bills (full shape) ===');
  for (const b of samples) {
    console.log(`\n  Bill ${b.Id} doc#${b.DocNumber ?? '-'} ${b.TxnDate} total $${money(b.TotalAmt)} balance $${money(b.Balance)}`);
    console.log(`    vendor=${b.VendorRef?.name ?? '?'}  AP=${b.APAccountRef?.name ?? '-'}  dept/location=${b.DepartmentRef?.name ?? '-'}  terms=${b.SalesTermRef?.name ?? '-'}`);
    if ((b.PrivateNote ?? '') !== '') console.log(`    note: ${b.PrivateNote}`);
    for (const l of b.Line ?? []) {
      const acct = l.AccountBasedExpenseLineDetail;
      const item = l.ItemBasedExpenseLineDetail;
      console.log(
        `      $${money(l.Amount).padStart(10)}  ${(l.DetailType ?? '?').padEnd(28)} ` +
        `${acct ? `acct=${acct.AccountRef?.name ?? '?'} class=${acct.ClassRef?.name ?? '-'}` : ''}` +
        `${item ? `item=${item.ItemRef?.name ?? '?'} qty=${item.Qty ?? '-'} unit=${item.UnitPrice ?? '-'} class=${item.ClassRef?.name ?? '-'}` : ''}` +
        `  "${(l.Description ?? '').slice(0, 46)}"`,
      );
    }
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
