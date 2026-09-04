/**
 * READ-ONLY: full all-time ledger for account 133 (2011 Accrued Expenses), MedRock FL.
 * Prints running balance and calls out balance at key checkpoints.
 */
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
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: AccountRef; Entity?: { EntityRef?: { name?: string } } };
  AccountBasedExpenseLineDetail?: { AccountRef?: AccountRef };
  DepositLineDetail?: { AccountRef?: AccountRef };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; EntityRef?: { name?: string }; PaymentType?: string; Line?: QbLine[] }

interface Row { date: string; type: string; doc: string; vendor: string; memo: string; debit: number; credit: number }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const rows: Row[] = [];

  const jes = await qbQueryAll<QbTxn>('MedRock FL' as never, 'JournalEntry', '');
  for (const je of jes) {
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      const isDebit = d.PostingType === 'Debit';
      rows.push({ type: 'JE', date: je.TxnDate ?? '', doc: je.DocNumber ?? '', vendor: d.Entity?.EntityRef?.name ?? '', memo: l.Description ?? je.PrivateNote ?? '', debit: isDebit ? amt : 0, credit: isDebit ? 0 : amt });
    }
  }
  const purchases = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Purchase', '');
  for (const p of purchases) {
    for (const l of p.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: `Purchase(${p.PaymentType ?? '?'})`, date: p.TxnDate ?? '', doc: p.DocNumber ?? '', vendor: p.EntityRef?.name ?? '', memo: l.Description ?? '', debit: amt < 0 ? 0 : Math.abs(amt), credit: amt < 0 ? Math.abs(amt) : 0 });
    }
  }
  const bills = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Bill', '');
  for (const b of bills) {
    for (const l of b.Line ?? []) {
      const d = l.AccountBasedExpenseLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: 'Bill', date: b.TxnDate ?? '', doc: b.DocNumber ?? '', vendor: b.EntityRef?.name ?? '', memo: l.Description ?? '', debit: amt < 0 ? 0 : Math.abs(amt), credit: amt < 0 ? Math.abs(amt) : 0 });
    }
  }
  const deposits = await qbQueryAll<QbTxn>('MedRock FL' as never, 'Deposit', '');
  for (const dep of deposits) {
    for (const l of dep.Line ?? []) {
      const d = l.DepositLineDetail;
      if (d?.AccountRef?.value !== TARGET_ACCOUNT_ID) continue;
      const amt = l.Amount ?? 0;
      rows.push({ type: 'Deposit', date: dep.TxnDate ?? '', doc: dep.DocNumber ?? '', vendor: dep.EntityRef?.name ?? '', memo: l.Description ?? '', debit: 0, credit: amt });
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.doc < b.doc ? -1 : 1));

  let bal = 0; // Cr - Dr running (liability convention: credit increases)
  const checkpoints: Record<string, number> = {};
  for (const r of rows) {
    bal += r.credit - r.debit;
    if (r.date === '2024-12-31') checkpoints['end-2024 (after this row)'] = bal;
    if (r.date === '2025-12-31') checkpoints['end-2025 (after this row)'] = bal;
  }

  // Print totals by year
  const byYear = new Map<string, { dr: number; cr: number }>();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    const cur = byYear.get(y) ?? { dr: 0, cr: 0 };
    cur.dr += r.debit;
    cur.cr += r.credit;
    byYear.set(y, cur);
  }
  console.log('Activity by year (all txn types hitting acct 133):');
  let cum = 0;
  for (const [y, v] of [...byYear.entries()].sort()) {
    cum += v.cr - v.dr;
    console.log(`  ${y}: Dr ${v.dr.toFixed(2).padStart(12)}  Cr ${v.cr.toFixed(2).padStart(12)}  net(Cr-Dr) ${(v.cr - v.dr).toFixed(2).padStart(12)}  CUMULATIVE ${cum.toFixed(2).padStart(12)}`);
  }

  console.log(`\nTotal rows all-time: ${rows.length}`);
  console.log(`Earliest date: ${rows[0]?.date}`);
  console.log(`\nFinal cumulative balance (all-time, Cr-Dr): ${bal.toFixed(2)}`);
  console.log(`QB reports CurrentBalance (live) as: -33039.04 (queried separately)`);

  // Print full 2024 detail for audit
  console.log('\n===== 2024 detail =====');
  let b24 = 0;
  for (const r of rows.filter((r) => r.date.startsWith('2024'))) {
    b24 += r.credit - r.debit;
    console.log(`${r.date}  ${r.type.padEnd(16)} ${r.doc.padEnd(24)} Dr ${r.debit.toFixed(2).padStart(10)}  Cr ${r.credit.toFixed(2).padStart(10)}  run=${b24.toFixed(2).padStart(12)}  ${r.vendor}  ${r.memo}`);
  }
  console.log(`2024 ending balance (opening for 2025): ${b24.toFixed(2)}`);
  console.log(`Kristi's stated 1/1/2026 OPENING balance: -13481.51 (NOTE: likely means 1/1/2025 opening carried, mislabel, or her window)`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
