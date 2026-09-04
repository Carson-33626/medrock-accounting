/**
 * READ-ONLY: pull ALL activity touching QB Account 133 (2011 Accrued Expenses) in MedRock FL,
 * from 2025-01-01 through today, across JournalEntry / Purchase / Bill / Deposit / BillPayment.
 * Prints a chronological ledger with running balance (Credit increases liability, per QB convention).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const TARGET_ACCOUNT_ID = '133'; // 2011 Accrued Expenses

interface AccountRef { value?: string; name?: string }
interface QbLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: AccountRef;
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
    Entity?: { EntityRef?: { name?: string } };
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef?: AccountRef;
    ClassRef?: { name?: string };
    CustomerRef?: { name?: string };
  };
  DepositLineDetail?: {
    AccountRef?: AccountRef;
  };
}
interface QbTxn {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  EntityRef?: { name?: string };
  PaymentType?: string;
  Line?: QbLine[];
}

interface LedgerRow {
  txnType: string;
  id: string;
  doc: string;
  date: string;
  vendor: string;
  memo: string;
  debit: number;
  credit: number;
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const rows: LedgerRow[] = [];

  // --- JournalEntry ---
  const jes = await qbQueryAll<QbTxn>('MedRock FL' as never, 'JournalEntry', "WHERE TxnDate >= '2025-01-01'");
  for (const je of jes) {
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      const isDebit = d.PostingType === 'Debit';
      rows.push({
        txnType: 'JournalEntry',
        id: je.Id ?? '',
        doc: je.DocNumber ?? '',
        date: je.TxnDate ?? '',
        vendor: d.Entity?.EntityRef?.name ?? '',
        memo: l.Description ?? je.PrivateNote ?? '',
        debit: isDebit ? amt : 0,
        credit: isDebit ? 0 : amt,
      });
    }
  }

  // --- Purchase (covers Ramp/CC charges AND checks, distinguished by PaymentType) ---
  const purchases = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Purchase', "WHERE TxnDate >= '2025-01-01'");
  for (const p of purchases) {
    for (const l of p.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      // Purchase (expense) lines to an expense/liability account are debits (increase expense / decrease liability)
      // unless this is a credit-card-credit / refund. QBO Purchase doesn't carry PostingType on the line;
      // TotalAmt sign or the Purchase's own Credit flag would indicate refunds. We treat all as Debit by default
      // and flag negative amounts separately.
      const isNegative = amt < 0;
      rows.push({
        txnType: `Purchase(${p.PaymentType ?? '?'})`,
        id: p.Id ?? '',
        doc: p.DocNumber ?? '',
        date: p.TxnDate ?? '',
        vendor: p.EntityRef?.name ?? '',
        memo: l.Description ?? '',
        debit: isNegative ? 0 : Math.abs(amt),
        credit: isNegative ? Math.abs(amt) : 0,
      });
    }
  }

  // --- Bill ---
  const bills = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Bill', "WHERE TxnDate >= '2025-01-01'");
  for (const b of bills) {
    for (const l of b.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({
        txnType: 'Bill',
        id: b.Id ?? '',
        doc: b.DocNumber ?? '',
        date: b.TxnDate ?? '',
        vendor: b.EntityRef?.name ?? '',
        memo: l.Description ?? '',
        debit: amt < 0 ? 0 : Math.abs(amt),
        credit: amt < 0 ? Math.abs(amt) : 0,
      });
    }
  }

  // --- Deposit ---
  const deposits = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Deposit', "WHERE TxnDate >= '2025-01-01'");
  for (const dep of deposits) {
    for (const l of dep.Line ?? []) {
      const d = l.DepositLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({
        txnType: 'Deposit',
        id: dep.Id ?? '',
        doc: dep.DocNumber ?? '',
        date: dep.TxnDate ?? '',
        vendor: dep.EntityRef?.name ?? '',
        memo: l.Description ?? '',
        debit: 0,
        credit: amt, // deposits into a liability account increase it (rare/unusual — flag)
      });
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let bal = 0;
  console.log(`\n===== Account 133 (2011 Accrued Expenses) — MedRock FL — full ledger 2025-01-01 to present =====`);
  console.log(`Rows found: ${rows.length}\n`);
  for (const r of rows) {
    bal += r.credit - r.debit; // credit increases liability balance (more negative in QB's signed display)
    console.log(
      `${r.date}  ${r.txnType.padEnd(16)} ${r.doc.padEnd(28)} Dr ${r.debit.toFixed(2).padStart(10)}  Cr ${r.credit.toFixed(2).padStart(10)}  RunningNetCr=${bal.toFixed(2).padStart(12)}  ${r.vendor}  ${r.memo}`,
    );
  }

  const y2025 = rows.filter((r) => r.date < '2026-01-01');
  const y2026 = rows.filter((r) => r.date >= '2026-01-01');
  const sum = (arr: LedgerRow[]) => arr.reduce((s, r) => s + r.credit - r.debit, 0);
  console.log(`\n--- SUMMARY ---`);
  console.log(`2025 net (Cr-Dr): ${sum(y2025).toFixed(2)}  (rows: ${y2025.length})`);
  console.log(`2026 YTD net (Cr-Dr): ${sum(y2026).toFixed(2)}  (rows: ${y2026.length})`);
  console.log(`TOTAL net (Cr-Dr): ${sum(rows).toFixed(2)}`);
  console.log(`\nCheckpoints to verify against Kristi's report:`);
  console.log(`  Expect 2025 ending / 2026 opening balance = -13,481.51`);
  console.log(`  Expect Q1-2026 (through 03-31) ending balance = -25,949.27`);
  const q1 = rows.filter((r) => r.date < '2026-04-01');
  console.log(`  Our computed cumulative through 2026-03-31: ${sum(q1).toFixed(2)}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
