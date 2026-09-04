/** READ-ONLY: find ALL Salesforce-vendor Bills/Purchases in MedRock FL, any account, any date. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine {
  Amount?: number; Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: { value?: string; name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; Balance?: number; EntityRef?: { name?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  for (const entity of ['Bill', 'Purchase'] as const) {
    const items = await qbQueryAll<QbTxn>('MedRock FL' as never, entity, '');
    const sf = items.filter((t) => (t.EntityRef?.name ?? '').toLowerCase().includes('salesforce'));
    console.log(`\n===== ${entity}: Salesforce vendor txns (${sf.length}) =====`);
    for (const t of sf) {
      console.log(`${t.TxnDate}  ${t.DocNumber ?? t.Id}  Total=${t.TotalAmt}  Balance=${t.Balance ?? 'n/a'}`);
      for (const l of t.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef;
        if (!acct) continue;
        console.log(`    -> Acct ${acct.value} "${acct.name}"  Amt=${l.Amount}  ${l.Description ?? ''}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
