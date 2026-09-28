// READ-ONLY: every journal entry in the month that touches an Income account, per company —
// shows which entries already moved the class-split deposit revenue between entities.
// Usage: npx tsx scripts/payroll/_probe-revenue-moving-jes.ts 2026-05
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { monthEndIso } from '../../src/lib/payroll/month';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import type { QbJournalEntry } from '../../src/lib/payroll/eom-manual';

interface QbAccount { Id: string; Name: string; Classification?: string; AccountType?: string }

async function main(): Promise<void> {
  const [y, mo] = (process.argv[2] ?? '2026-05').split('-').map(Number);
  const first = `${y}-${String(mo).padStart(2, '0')}-01`;
  const last = monthEndIso({ year: y, month: mo });
  for (const e of EOM_ENTITIES) {
    const accts = await qbQueryAll<QbAccount>(e, 'Account', `WHERE Classification = 'Revenue'`);
    const income = new Set(accts.map((a) => a.Name));
    console.log(`\n== ${e} income accounts: ${[...income].join(' | ')}`);
    const jes = await qbQueryAll<QbJournalEntry>(e, 'JournalEntry', `WHERE TxnDate >= '${first}' AND TxnDate <= '${last}'`);
    for (const je of jes) {
      let net = 0;
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const name = d?.AccountRef?.name ?? '';
        const leaf = name.split(':').pop()?.trim() ?? name;
        if (!income.has(name) && !income.has(leaf)) continue;
        net += (d?.PostingType === 'Credit' ? 1 : -1) * (l.Amount ?? 0);
      }
      if (Math.abs(net) > 0.004) console.log(`  JE ${je.Id} ${je.TxnDate} "${je.DocNumber ?? ''}" income net ${net.toFixed(2)}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
