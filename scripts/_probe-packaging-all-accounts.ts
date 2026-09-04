// READ-ONLY: do the packaging vendors get coded ANYWHERE other than 1220.15 / 5000.15?
// Modelled consumption is 123% of the spend I measured on those two accounts. If the
// same vendors also bill to other accounts, the denominator was too small.
import './lib/load-env';
import { qbQueryAll, getConnectedLocations, type Location } from '../src/lib/quickbooks-multi';

interface Acct { Id: string; AcctNum?: string; FullyQualifiedName?: string }
interface Line { Amount?: number; AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string } } }
interface Doc { Id: string; TxnDate?: string; VendorRef?: { name?: string }; Line?: Line[] }

const VENDOR_HINTS = [
  'cosmetic packaging', 'medisca', 'interestpack', 'uline', 'new marine',
  'us plastic', 'usplastics', 'bottlemate', 'dropperbottles', 'container and packaging',
  'vial store', 'berlin packaging', 'specialty bottle', 'green rush',
];

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
      const byAcct = new Map<string, number>();
      for (const d of [...bills, ...purchases]) {
        const v = (d.VendorRef?.name ?? '').toLowerCase();
        if (!VENDOR_HINTS.some((h) => v.includes(h))) continue;
        for (const l of d.Line ?? []) {
          const ref = l.AccountBasedExpenseLineDetail?.AccountRef?.value;
          if (!ref) continue;
          const label = byId.get(ref) ?? ref;
          byAcct.set(label, (byAcct.get(label) ?? 0) + (l.Amount ?? 0));
        }
      }
      console.log(`\n${location} — 2026 spend from packaging vendors, BY ACCOUNT:`);
      const sorted = [...byAcct.entries()].sort((a, b) => b[1] - a[1]);
      let other = 0;
      for (const [label, amt] of sorted) {
        const isPack = label.startsWith('1220.15') || label.startsWith('5000.15');
        if (!isPack) other += amt;
        console.log(`  ${isPack ? ' ' : '*'} ${label.slice(0, 46).padEnd(46)} ${amt.toFixed(2).padStart(12)}`);
      }
      console.log(`  * = NOT counted in the earlier measurement. Total elsewhere: ${other.toFixed(2)}`);
    } catch (e) {
      console.log(`${location}: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
