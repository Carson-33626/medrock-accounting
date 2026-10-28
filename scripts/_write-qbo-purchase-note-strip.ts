/** Strip ONE exact sentence from the PrivateNote (memo) of QBO Purchases that Ramp synced before the
 *  Ramp-side memo was corrected. Barbara 2026-10-28: the "No receipt from cardholder; approved 10/28 to
 *  close May ..." note must not appear in the books. Sparse update, SyncToken-checked, read back.
 *  Dry-run by default; --live to write.
 *
 *    npx tsx scripts/_write-qbo-purchase-note-strip.ts <FL|TN|TX> "<exact sentence>" --ids=<PurchaseId>,... [--live]
 *
 *  Ramp does not write its txn id into the QBO Purchase, so targets are QBO Purchase Ids (find them with a
 *  PrivateNote query first). Strips the sentence from every line, keeps the cardholder prefix.
 */
import './payroll/load-env-vercel-first';
import { qbQueryAll, qbPost } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface Purchase { Id: string; SyncToken: string; PaymentType?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; PrivateNote?: string; EntityRef?: { name?: string } }
interface PurchaseResp { Purchase: Purchase }

const LOCS: Record<string, Location> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
const args = process.argv.slice(2);
const live = args.includes('--live');
const pos = args.filter((a) => !a.startsWith('--'));
const [key, sentence] = pos;
const idsArg = args.find((a) => a.startsWith('--ids='));
if (!key || !sentence || !idsArg || !(key in LOCS)) throw new Error('usage: <FL|TN|TX> "<exact sentence>" --ids=<PurchaseId>,... [--live]');
const loc = LOCS[key];
const ids = idsArg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean);

function stripSentence(note: string): string {
  return note
    .split('\n')
    .map((l) => l.replace(sentence, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+-\s*$/, '').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

async function main(): Promise<void> {
  for (const id of ids) {
    const hits = await qbQueryAll<Purchase>(loc, 'Purchase', `WHERE Id = '${id}'`);
    if (hits.length !== 1) { console.log(`${id}: ${hits.length} purchases match -> skip`); continue; }
    const p = hits[0];
    const prior = p.PrivateNote ?? '';
    if (!prior.includes(sentence)) { console.log(`Purchase ${p.Id} note does not contain the sentence -> skip\n  note: ${JSON.stringify(prior)}`); continue; }
    const next = stripSentence(prior);
    console.log(`Purchase ${p.Id} ${p.TxnDate} $${p.TotalAmt} ${p.EntityRef?.name ?? ''} SyncToken=${p.SyncToken}\n  before: ${JSON.stringify(prior)}\n  after : ${JSON.stringify(next)}`);
    if (!live) continue;
    const res = await qbPost<PurchaseResp>(loc, 'purchase?operation=update', { Id: p.Id, SyncToken: p.SyncToken, PaymentType: p.PaymentType ?? 'CreditCard', sparse: true, PrivateNote: next });
    const back = res.Purchase;
    const ok = (back.PrivateNote ?? '') === next;
    console.log(`  UPDATE -> SyncToken ${back.SyncToken}; readback ${ok ? 'OK' : 'MISMATCH: ' + JSON.stringify(back.PrivateNote)}`);
  }
  if (!live) console.log('--- DRY RUN. Add --live to write. ---');
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
