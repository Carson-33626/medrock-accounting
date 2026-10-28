/** READ-ONLY: for every purchase in receipt-enrichment/cache/may-alloc/unpaired.json, print its lines
 *  (account, class, amount), memo, and a memo-vs-target conflict flag. Writes cache/may-alloc/lines.json
 *  for the UI allocation run (target category = same account name/number on the target company).
 *
 *    npx tsx scripts/_probe-may-alloc-lines.ts
 */
import './payroll/load-env-vercel-first';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface Ref { value?: string; name?: string }
interface PLine {
  Amount?: number;
  Description?: string;
  AccountBasedExpenseLineDetail?: { ClassRef?: Ref; AccountRef?: Ref };
  ItemBasedExpenseLineDetail?: { ClassRef?: Ref; ItemRef?: Ref };
}
interface Purchase { Id: string; TxnDate?: string; TotalAmt?: number; PrivateNote?: string; EntityRef?: Ref; Line?: PLine[] }
interface Unpaired { key: string; id: string; date: string; payee: string; target: string; amt: number }
interface Account { Id: string; AcctNum?: string; FullyQualifiedName?: string }
interface OutLine { account: string; acctNum: string; cls: string; amount: number }
interface OutRow extends Unpaired { lines: OutLine[]; memo: string; conflict: string }

const LOCS: Record<string, Location> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
const DIR = resolve(__dirname, '..', '..', 'receipt-enrichment', 'cache', 'may-alloc');
const WORDS: Record<string, RegExp> = {
  FL: /\b(FL|Florida|Tampa|Clearwater)\b/i,
  TN: /\b(TN|Tennessee|Knoxville|Nashville)\b/i,
  TX: /\b(TX|Texas|Keller|Fort Worth|Dallas|DFW)\b/i,
};

async function main(): Promise<void> {
  const unpaired = JSON.parse(readFileSync(resolve(DIR, 'unpaired.json'), 'utf8')) as Unpaired[];
  const out: OutRow[] = [];
  for (const key of ['FL', 'TN']) {
    const ids = unpaired.filter((u) => u.key === key).map((u) => u.id);
    if (ids.length === 0) continue;
    const byId = new Map<string, Purchase>();
    const acctNum = new Map<string, string>();
    for (const a of await qbQueryAll<Account>(LOCS[key], 'Account', '')) acctNum.set(a.Id, a.AcctNum ?? '');
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40).map((x) => `'${x}'`).join(',');
      for (const p of await qbQueryAll<Purchase>(LOCS[key], 'Purchase', `WHERE Id IN (${chunk})`)) byId.set(p.Id, p);
    }
    for (const u of unpaired.filter((x) => x.key === key)) {
      const p = byId.get(u.id);
      if (!p) { console.log(`${key} ${u.id} NOT FOUND`); continue; }
      const lines: OutLine[] = (p.Line ?? []).map((l) => ({
        account: l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? `ITEM:${l.ItemBasedExpenseLineDetail?.ItemRef?.name ?? '?'}`,
        acctNum: acctNum.get(l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? '') ?? '',
        cls: l.AccountBasedExpenseLineDetail?.ClassRef?.name ?? l.ItemBasedExpenseLineDetail?.ClassRef?.name ?? '',
        amount: l.Amount ?? 0,
      }));
      const memo = [p.PrivateNote ?? '', ...(p.Line ?? []).map((l) => l.Description ?? '')].join(' ').trim();
      const others = Object.keys(WORDS).filter((k) => k !== u.target && k !== key && WORDS[k].test(memo));
      const conflict = others.length ? `memo mentions ${others.join('/')} but class targets ${u.target}` : '';
      const multi = lines.filter((l) => /^Allocate - /.test(l.cls)).length > 1 ? ' MULTI-LINE' : '';
      const item = lines.some((l) => l.account.startsWith('ITEM:')) ? ' ITEM-LINE' : '';
      out.push({ ...u, lines, memo, conflict: (conflict + multi + item).trim() });
      console.log(`${key} ${u.id} ${u.date} ${u.amt.toFixed(2)} -> ${u.target} | ${u.payee} | ${lines.map((l) => `${l.account} [${l.cls}] ${l.amount.toFixed(2)}`).join('; ')}${conflict || multi || item ? `  <<< ${conflict}${multi}${item}` : ''}`);
    }
  }
  writeFileSync(resolve(DIR, 'lines.json'), JSON.stringify(out, null, 1));
  console.log(`\n${out.length} rows; conflicts: ${out.filter((r) => r.conflict).length}; wrote ${resolve(DIR, 'lines.json')}`);
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
