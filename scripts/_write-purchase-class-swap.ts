/** Swap the directed-allocation class on QBO Purchases: every line carrying `Allocate - <FROM>` gets
 *  `Allocate - <TO>`. Carson 2026-10-28: Tiffany Mitchell's May AZ field ride (13 FL purchases, memo
 *  "Bill to TN") was classed Allocate - TX; Arizona is served by TN, so the class moves to TN before the
 *  intercompany allocation is run. Sparse update with the full Line array, SyncToken-checked, read back.
 *  Dry-run by default; --live to write.
 *
 *    npx tsx scripts/_write-purchase-class-swap.ts <FL|TN|TX> <FROM> <TO> --ids=<PurchaseId>,... [--live]
 */
import './payroll/load-env-vercel-first';
import { qbQueryAll, qbPost } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface Ref { value?: string; name?: string }
interface PLine {
  Id?: string;
  LineNum?: number;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { ClassRef?: Ref; AccountRef?: Ref; BillableStatus?: string; TaxCodeRef?: Ref; CustomerRef?: Ref };
  ItemBasedExpenseLineDetail?: { ClassRef?: Ref; ItemRef?: Ref; Qty?: number; UnitPrice?: number; BillableStatus?: string; TaxCodeRef?: Ref; CustomerRef?: Ref };
}
interface Purchase { Id: string; SyncToken: string; PaymentType?: string; TxnDate?: string; TotalAmt?: number; EntityRef?: Ref; Line?: PLine[] }
interface PurchaseResp { Purchase: Purchase }
interface QClass { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }

const LOCS: Record<string, Location> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
const args = process.argv.slice(2);
const live = args.includes('--live');
const [key, from, to] = args.filter((a) => !a.startsWith('--'));
const idsArg = args.find((a) => a.startsWith('--ids='));
if (!key || !from || !to || !idsArg || !(key in LOCS)) throw new Error('usage: <FL|TN|TX> <FROM> <TO> --ids=<PurchaseId>,... [--live]');
const loc = LOCS[key];
const ids = idsArg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean);
const fromName = `Allocate - ${from}`;
const toName = `Allocate - ${to}`;

function classOf(l: PLine): Ref | undefined {
  return l.AccountBasedExpenseLineDetail?.ClassRef ?? l.ItemBasedExpenseLineDetail?.ClassRef;
}

async function main(): Promise<void> {
  const classes = await qbQueryAll<QClass>(loc, 'Class', `WHERE Name = '${toName}'`);
  const toCls = classes.find((c) => c.Active !== false);
  if (!toCls) throw new Error(`${loc}: class "${toName}" not found`);
  console.log(`${loc}: ${fromName} -> ${toName} (ClassRef ${toCls.Id})`);
  for (const id of ids) {
    const hits = await qbQueryAll<Purchase>(loc, 'Purchase', `WHERE Id = '${id}'`);
    if (hits.length !== 1) { console.log(`${id}: ${hits.length} purchases match -> skip`); continue; }
    const p = hits[0];
    const lines = p.Line ?? [];
    const swap = lines.filter((l) => classOf(l)?.name === fromName);
    const other = lines.filter((l) => classOf(l) && classOf(l)?.name !== fromName);
    if (swap.length === 0) { console.log(`Purchase ${p.Id} has no ${fromName} line -> skip (${lines.map((l) => classOf(l)?.name ?? '-').join(', ')})`); continue; }
    if (other.length > 0) { console.log(`Purchase ${p.Id} mixes classes (${other.map((l) => classOf(l)?.name).join(', ')}) -> skip`); continue; }
    const newLines: PLine[] = lines.map((l) => {
      if (l.AccountBasedExpenseLineDetail) return { ...l, AccountBasedExpenseLineDetail: { ...l.AccountBasedExpenseLineDetail, ClassRef: { value: toCls.Id, name: toName } } };
      if (l.ItemBasedExpenseLineDetail) return { ...l, ItemBasedExpenseLineDetail: { ...l.ItemBasedExpenseLineDetail, ClassRef: { value: toCls.Id, name: toName } } };
      return l;
    });
    console.log(`Purchase ${p.Id} ${p.TxnDate} $${p.TotalAmt} ${p.EntityRef?.name ?? ''} SyncToken=${p.SyncToken}: ${swap.length} line(s) ${fromName} -> ${toName}`);
    if (!live) continue;
    const body = { Id: p.Id, SyncToken: p.SyncToken, PaymentType: p.PaymentType ?? 'CreditCard', sparse: true, Line: newLines };
    const res = await qbPost<PurchaseResp>(loc, 'purchase?operation=update', JSON.parse(JSON.stringify(body)));
    const back = res.Purchase;
    const backCls = (back.Line ?? []).map((l) => classOf(l)?.name ?? '-');
    const ok = backCls.every((c) => c === toName) && back.TotalAmt === p.TotalAmt && (back.Line ?? []).length === lines.length;
    console.log(`  UPDATE -> SyncToken ${back.SyncToken}; readback ${ok ? 'OK' : 'MISMATCH ' + JSON.stringify({ backCls, total: back.TotalAmt, n: (back.Line ?? []).length })}`);
  }
  if (!live) console.log('--- DRY RUN. Add --live to write. ---');
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
