// READ-ONLY: 2026 spend coded to the packaging accounts, per entity — the sanity check on
// a usage-based valuation. If measured consumption is far above real spend, the model
// overstates; if far below, purchases are landing somewhere else.
import './lib/load-env';
import { qbQueryAll, getConnectedLocations, type Location } from '../src/lib/quickbooks-multi';

interface Acct { Id: string; AcctNum?: string; FullyQualifiedName?: string }
interface Line { Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } } }
interface Doc { Id: string; TxnDate?: string; Line?: Line[] }

const WANTED = ['1220.15', '5000.15'];

async function main(): Promise<void> {
  for (const location of await getConnectedLocations()) {
    if (String(location) === 'FOCAS') continue;
    try {
      const accts = await qbQueryAll<Acct>(location as Location, 'Account', '');
      const ids = new Map<string, string>();
      for (const a of accts) if (a.AcctNum && WANTED.includes(a.AcctNum)) ids.set(a.Id, a.AcctNum);
      if (ids.size === 0) { console.log(`${location}: no packaging accounts`); continue; }

      const where = `WHERE TxnDate >= '2026-01-01'`;
      const [bills, purchases] = await Promise.all([
        qbQueryAll<Doc>(location as Location, 'Bill', where),
        qbQueryAll<Doc>(location as Location, 'Purchase', where),
      ]);
      const byAcct = new Map<string, { amt: number; docs: Set<string> }>();
      for (const d of [...bills, ...purchases]) {
        for (const l of d.Line ?? []) {
          const ref = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
          const num = ref ? ids.get(ref) : undefined;
          if (!num) continue;
          const acc = byAcct.get(num) ?? { amt: 0, docs: new Set() };
          acc.amt += l.Amount ?? 0;
          acc.docs.add(d.Id);
          byAcct.set(num, acc);
        }
      }
      const parts = [...byAcct.entries()].map(([n, v]) => `${n} $${v.amt.toFixed(2)} (${v.docs.size} docs)`);
      console.log(`${String(location).padEnd(12)} 2026 YTD: ${parts.length ? parts.join('  |  ') : 'nothing coded'}`);
    } catch (e) {
      console.log(`${location}: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
