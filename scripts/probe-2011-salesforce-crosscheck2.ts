/** READ-ONLY: broaden Salesforce search — by vendor list, and by description keyword across Bill/Purchase/JE, any account. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbVendor { Id?: string; DisplayName?: string }
interface QbLine {
  Amount?: number; Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string; name?: string } };
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { value?: string; name?: string }; Entity?: { EntityRef?: { name?: string } } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; Balance?: number; EntityRef?: { name?: string }; PrivateNote?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');

  const vendors = await qbQueryAll<QbVendor>('MedRock FL' as never, 'Vendor', '');
  const sfVendors = vendors.filter((v) => (v.DisplayName ?? '').toLowerCase().includes('salesforce'));
  console.log('Vendors matching "salesforce":', sfVendors.map((v) => `${v.Id}:${v.DisplayName}`));

  for (const entity of ['Bill', 'Purchase'] as const) {
    const items = await qbQueryAll<QbTxn>('MedRock FL' as never, entity, '');
    const hits = items.filter((t) =>
      (t.Line ?? []).some((l) => (l.Description ?? '').toLowerCase().includes('salesforce')),
    );
    console.log(`\n===== ${entity}: line description contains "salesforce" (${hits.length}) =====`);
    for (const t of hits) {
      console.log(`${t.TxnDate}  ${t.DocNumber ?? t.Id}  Vendor=${t.EntityRef?.name}  Total=${t.TotalAmt}  Balance=${t.Balance ?? 'n/a'}`);
      for (const l of t.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef;
        if (acct) console.log(`    -> Acct ${acct.value} "${acct.name}"  Amt=${l.Amount}  ${l.Description ?? ''}`);
      }
    }
  }

  const jes = await qbQueryAll<QbTxn>('MedRock FL' as never, 'JournalEntry', '');
  const jeHits = jes.filter((je) => (je.Line ?? []).some((l) => (l.Description ?? '').toLowerCase().includes('salesforce')));
  console.log(`\n===== JournalEntry: line description contains "salesforce" (${jeHits.length}) =====`);
  for (const je of jeHits) {
    console.log(`${je.TxnDate}  ${je.DocNumber ?? je.Id}  Note=${je.PrivateNote ?? ''}`);
    for (const l of je.Line ?? []) {
      if (!(l.Description ?? '').toLowerCase().includes('salesforce')) continue;
      const d = l.JournalEntryLineDetail;
      console.log(`    -> ${d?.PostingType} Acct ${d?.AccountRef?.value} "${d?.AccountRef?.name}"  Amt=${l.Amount}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
