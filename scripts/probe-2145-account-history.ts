/** READ-ONLY: full transaction history + info for QB account "2145 Due to Medisca" (MedRock FL). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbAccount {
  Id?: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
  CurrentBalance?: number;
  Active?: boolean;
}

interface QbLineAccountRef { value?: string; name?: string }
interface QbLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: QbLineAccountRef;
    ClassRef?: { name?: string };
    Entity?: { EntityRef?: { name?: string; type?: string } };
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QbLineAccountRef;
  };
}
interface QbTxnBase {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  Line?: QbLine[];
  EntityRef?: { name?: string; type?: string };
  VendorRef?: { name?: string; value?: string };
  PaymentType?: string;
  AccountRef?: QbLineAccountRef;
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const LOC = 'MedRock FL' as never;

  // 1. Find the account
  const accounts = await qbQueryAll<QbAccount>(LOC, 'Account', "WHERE Name LIKE '%Medisca%'");
  console.log('=== Accounts matching "Medisca" ===');
  for (const a of accounts) {
    console.log(`  Id=${a.Id}  Name="${a.Name}"  Type=${a.AccountType}/${a.AccountSubType}  Balance=${a.CurrentBalance}  Active=${a.Active}`);
  }
  const acct2145 = accounts.find((a) => a.Name === 'Due to Medisca');
  if (!acct2145) {
    console.log('!!! Could not find "Due to Medisca" account — dumping ALL liability accounts');
    const allLiab = await qbQueryAll<QbAccount>(LOC, 'Account', "WHERE AccountType = 'Other Current Liability'");
    for (const a of allLiab) console.log(`  Id=${a.Id}  Name="${a.Name}"  Balance=${a.CurrentBalance}`);
    return;
  }
  const acctId = acct2145.Id!;
  console.log(`\n>>> Using account Id=${acctId} "${acct2145.Name}" CurrentBalance=${acct2145.CurrentBalance}\n`);

  // 2. Vendor records matching Medisca
  console.log('=== Vendors matching "Medisca" ===');
  const vendors = await qbQueryAll<{ Id?: string; DisplayName?: string; Active?: boolean; Balance?: number }>(
    LOC, 'Vendor', "WHERE DisplayName LIKE '%Medisca%'",
  );
  for (const v of vendors) {
    console.log(`  Id=${v.Id}  DisplayName="${v.DisplayName}"  Balance=${v.Balance}  Active=${v.Active}`);
  }

  // 3. Pull every transaction type referencing this account, all-time.
  const entities = ['Purchase', 'JournalEntry', 'Bill', 'BillPayment', 'Deposit', 'VendorCredit'] as const;
  interface Row { type: string; id: string; date: string; doc: string; amt: number; who: string; note: string; postingType: string }
  const rows: Row[] = [];

  for (const entity of entities) {
    const all = await qbQueryAll<QbTxnBase>(LOC, entity, "WHERE TxnDate >= '2015-01-01'");
    for (const txn of all) {
      const lines = txn.Line ?? [];
      let matched = false;
      for (const l of lines) {
        const jeAcct = l.JournalEntryLineDetail?.AccountRef;
        const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef;
        const acctRef = jeAcct ?? expAcct;
        if (acctRef?.value === acctId) {
          matched = true;
          const postingType = l.JournalEntryLineDetail?.PostingType ?? '';
          const entityName = l.JournalEntryLineDetail?.Entity?.EntityRef?.name ?? '';
          rows.push({
            type: entity,
            id: txn.Id ?? '',
            date: txn.TxnDate ?? '',
            doc: txn.DocNumber ?? '',
            amt: l.Amount ?? 0,
            who: txn.VendorRef?.name ?? txn.EntityRef?.name ?? entityName,
            note: (txn.PrivateNote ?? l.Description ?? '').slice(0, 80),
            postingType,
          });
        }
      }
      // Also check if the txn-level AccountRef (e.g. Deposit/BillPayment bank account is NOT this;
      // but some entities like Purchase have top-level AccountRef for the payment account, not relevant)
      if (!matched && txn.AccountRef?.value === acctId) {
        rows.push({
          type: entity,
          id: txn.Id ?? '',
          date: txn.TxnDate ?? '',
          doc: txn.DocNumber ?? '',
          amt: txn.TotalAmt ?? 0,
          who: txn.VendorRef?.name ?? txn.EntityRef?.name ?? '',
          note: (txn.PrivateNote ?? '').slice(0, 80),
          postingType: '(top-level AccountRef)',
        });
      }
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`\n=== ${rows.length} lines touching account 2145, sorted by date ===`);
  let runningNet = 0;
  for (const r of rows) {
    const signedAmt = r.postingType === 'Credit' ? r.amt : r.postingType === 'Debit' ? -r.amt : r.amt;
    runningNet += signedAmt;
    console.log(
      `${r.date}  ${r.type.padEnd(13)} #${(r.doc || r.id).padEnd(14)} ${r.postingType.padEnd(20)} amt=${r.amt.toFixed(2).padStart(10)}  who="${r.who}"  running=${runningNet.toFixed(2)}  ${r.note}`,
    );
  }
  console.log(`\nTOTAL rows: ${rows.length}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
