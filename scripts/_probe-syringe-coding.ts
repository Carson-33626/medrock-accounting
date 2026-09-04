// READ-ONLY: are syringes coded to Lab Supplies (1220.20) or Compound Packaging (1220.15)?
// Carson ruled syringes are lab supplies, "the same boat as gloves". The lab-supplies accrual
// is computed from spend on 1220.20 + 5000.25, so if syringe buys land on 1220.15 instead the
// accrual silently misses them and packaging carries a lab supply.
import './lib/load-env';
import { qbQueryAll, getConnectedLocations, type Location } from '../src/lib/quickbooks-multi';

interface Acct { Id: string; AcctNum?: string; FullyQualifiedName?: string }
interface Line {
  Amount?: number;
  Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } };
}
interface Doc { Id: string; DocNumber?: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: Line[] }

// Match the line DESCRIPTION, not the vendor — syringes come from many suppliers.
const HINTS = ['syringe', 'luer'];
// Gloves as the control: Carson's stated comparator, so we can see where they land.
const CONTROL = ['glove', 'nitrile'];

function hit(text: string, words: readonly string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

async function main(): Promise<void> {
  for (const location of await getConnectedLocations()) {
    if (String(location) === 'FOCAS') continue;
    try {
      const accts = await qbQueryAll<Acct>(location as Location, 'Account', '');
      const byId = new Map(accts.map((a) => [a.Id, `${a.AcctNum ?? '—'} ${a.FullyQualifiedName ?? ''}`]));
      const where = `WHERE TxnDate >= '2026-01-01'`;
      const [bills, purchases] = await Promise.all([
        qbQueryAll<Doc>(location as Location, 'Bill', where),
        qbQueryAll<Doc>(location as Location, 'Purchase', where),
      ]);

      const tally = new Map<string, { amt: number; n: number; sample: string }>();
      for (const d of [...bills, ...purchases]) {
        for (const l of d.Line ?? []) {
          const desc = l.Description ?? '';
          const isSyringe = hit(desc, HINTS);
          const isGlove = hit(desc, CONTROL);
          if (!isSyringe && !isGlove) continue;
          const ref = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
          const key = `${isSyringe ? 'SYRINGE' : 'glove  '}  ${ref ? (byId.get(ref) ?? ref) : '(no account)'}`;
          const acc = tally.get(key) ?? { amt: 0, n: 0, sample: desc.slice(0, 58) };
          acc.amt += l.Amount ?? 0;
          acc.n += 1;
          tally.set(key, acc);
        }
      }

      console.log(`\n${location} — 2026 lines matching syringe/luer, with gloves as the control:`);
      if (tally.size === 0) { console.log('  (no matching line descriptions)'); continue; }
      for (const [k, v] of [...tally.entries()].sort((a, b) => b[1].amt - a[1].amt)) {
        console.log(`  ${k.slice(0, 60).padEnd(60)} ${v.amt.toFixed(2).padStart(10)}  ${String(v.n).padStart(3)} lines   e.g. ${v.sample}`);
      }
    } catch (e) {
      console.log(`${location}: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
