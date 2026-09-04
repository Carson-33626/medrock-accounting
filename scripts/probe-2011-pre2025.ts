/** READ-ONLY: check for ANY activity on account 133 (2011) before 2025-01-01, all txn types. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const TARGET_ACCOUNT_ID = '133';
interface AccountRef { value?: string; name?: string }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: AccountRef };
  AccountBasedExpenseLineDetail?: { AccountRef?: AccountRef };
  DepositLineDetail?: { AccountRef?: AccountRef };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; EntityRef?: { name?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  for (const entity of ['JournalEntry', 'Purchase', 'Bill', 'Deposit', 'VendorCredit', 'CreditCardCredit', 'Check'] as const) {
    let items: QbTxn[] = [];
    try {
      items = await qbQueryAll<QbTxn>('MedRock FL' as never, entity, '');
    } catch (e) {
      console.log(`${entity}: query failed (${(e as Error).message.slice(0, 120)})`);
      continue;
    }
    const pre2025 = items.filter((t) => (t.TxnDate ?? '9999') < '2025-01-01');
    let hitCount = 0;
    for (const t of pre2025) {
      for (const l of t.Line ?? []) {
        const acct =
          l.JournalEntryLineDetail?.AccountRef?.value ??
          l.AccountBasedExpenseLineDetail?.AccountRef?.value ??
          l.DepositLineDetail?.AccountRef?.value;
        if (acct === TARGET_ACCOUNT_ID) {
          hitCount++;
          console.log(`${entity} ${t.DocNumber ?? t.Id} ${t.TxnDate} ${t.EntityRef?.name ?? ''} amt=${l.Amount} desc=${l.Description ?? t.PrivateNote ?? ''}`);
        }
      }
    }
    console.log(`${entity}: total=${items.length}, pre-2025=${pre2025.length}, hits on 133=${hitCount}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
