/** READ-ONLY: the QuickBooks side of the Medisca 2145 reconciliation, all three entities.
 *
 *  For each of FL / TN / TX: the "Due to Medisca" account, every line touching it since
 *  2025-10-01 (bank-feed Purchases, JEs, Bills, BillPayments, Deposits, VendorCredits), and the
 *  Medisca vendor's Bills / VendorCredits / BillPayments in the same window with their account
 *  coding and open balances. JSON per entity to the scratchpad plus a readable dump.
 *    npx tsx scripts/probe-medisca-qbo-side.ts
 */
import './payroll/load-env-vercel-first';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

const OUT_ROOT =
  'C:/Users/Carson.D/AppData/Local/Temp/claude/C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics/86372a4b-bf3b-4d0b-a45d-84dc04c3885a/scratchpad/medisca/qbo';
const SINCE = '2025-10-01';
const LOCATIONS: readonly Location[] = process.argv.length > 2 ? (process.argv.slice(2) as Location[]) : ['MedRock FL', 'MedRock TN', 'MedRock TX'];

interface QbRef { value?: string; name?: string; type?: string }
interface QbAccount { Id: string; Name: string; AcctNum?: string; AccountType?: string; CurrentBalance?: number; Active?: boolean }
interface QbVendor { Id: string; DisplayName: string; Balance?: number; Active?: boolean }
interface QbLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: QbRef; Entity?: { EntityRef?: QbRef } };
  AccountBasedExpenseLineDetail?: { AccountRef?: QbRef };
  ItemBasedExpenseLineDetail?: { ItemRef?: QbRef };
  DepositLineDetail?: { AccountRef?: QbRef; Entity?: QbRef };
}
interface QbTxn {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  Balance?: number;
  Line?: QbLine[];
  EntityRef?: QbRef;
  VendorRef?: QbRef;
  AccountRef?: QbRef;
  PaymentType?: string;
  CheckPayment?: { BankAccountRef?: QbRef };
  DueDate?: string;
  MetaData?: { CreateTime?: string };
}

interface LedgerLine {
  entity: string;
  type: string;
  txnId: string;
  doc: string;
  date: string;
  posting: 'Debit' | 'Credit' | 'Increase' | 'Decrease' | 'n/a';
  amount: number;
  signedToAccount: number;
  who: string;
  memo: string;
  lineDesc: string;
  otherAccounts: string[];
  linked: string[];
}
interface VendorTxn {
  entity: string;
  type: string;
  txnId: string;
  doc: string;
  date: string;
  total: number;
  balance: number | null;
  memo: string;
  lines: Array<{ account: string; item: string; amount: number; desc: string }>;
  linked: string[];
  payAccount: string;
}

function lineAccount(l: QbLine): QbRef | undefined {
  return l.JournalEntryLineDetail?.AccountRef ?? l.AccountBasedExpenseLineDetail?.AccountRef ?? l.DepositLineDetail?.AccountRef;
}

async function main(): Promise<void> {
  mkdirSync(OUT_ROOT, { recursive: true });
  for (const location of LOCATIONS) {
    const tag = location.replace(/\s+/g, '_');
    console.log(`\n==================== ${location} ====================`);
    const accts = await qbQueryAll<QbAccount>(location, 'Account', "WHERE Name LIKE '%Medisca%'");
    const acct = accts.find((a) => /due to medisca/i.test(a.Name)) ?? accts[0];
    if (!acct) { console.log('  no Due to Medisca account'); continue; }
    console.log(`  account #${acct.Id} "${acct.Name}" acctnum=${acct.AcctNum ?? ''} type=${acct.AccountType} CurrentBalance=${acct.CurrentBalance}`);
    const vendors = await qbQueryAll<QbVendor>(location, 'Vendor', "WHERE DisplayName LIKE 'Medisca%'");
    for (const v of vendors) console.log(`  vendor #${v.Id} "${v.DisplayName}" balance=${v.Balance} active=${v.Active}`);
    const vendorIds = new Set(vendors.map((v) => v.Id));

    // 1. Every line touching 2145 since SINCE.
    const ledger: LedgerLine[] = [];
    for (const type of ['Purchase', 'JournalEntry', 'Bill', 'BillPayment', 'Deposit', 'VendorCredit'] as const) {
      const txns = await qbQueryAll<QbTxn>(location, type, `WHERE TxnDate >= '${SINCE}'`);
      for (const t of txns) {
        const lines = t.Line ?? [];
        const others = new Set<string>();
        for (const l of lines) { const a = lineAccount(l); if (a?.value && a.value !== acct.Id && a.name) others.add(a.name); }
        for (const l of lines) {
          const a = lineAccount(l);
          if (a?.value !== acct.Id) continue;
          const posting = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Debit'
            : l.JournalEntryLineDetail?.PostingType === 'Credit' ? 'Credit'
            : type === 'Purchase' ? 'Debit' : type === 'Deposit' ? 'Credit' : type === 'Bill' ? 'Credit' : type === 'VendorCredit' ? 'Debit' : 'n/a';
          const amount = l.Amount ?? 0;
          const signed = posting === 'Credit' ? amount : posting === 'Debit' ? -amount : 0;
          ledger.push({
            entity: location, type, txnId: t.Id, doc: t.DocNumber ?? '', date: t.TxnDate ?? '', posting, amount, signedToAccount: signed,
            who: t.VendorRef?.name ?? t.EntityRef?.name ?? l.JournalEntryLineDetail?.Entity?.EntityRef?.name ?? l.DepositLineDetail?.Entity?.name ?? '',
            memo: (t.PrivateNote ?? '').slice(0, 120), lineDesc: (l.Description ?? '').slice(0, 120),
            otherAccounts: [...others], linked: (l.LinkedTxn ?? []).map((x) => `${x.TxnType}:${x.TxnId}`),
          });
        }
        if (t.AccountRef?.value === acct.Id && !lines.some((l) => lineAccount(l)?.value === acct.Id)) {
          ledger.push({ entity: location, type, txnId: t.Id, doc: t.DocNumber ?? '', date: t.TxnDate ?? '', posting: 'n/a', amount: t.TotalAmt ?? 0, signedToAccount: 0, who: t.VendorRef?.name ?? t.EntityRef?.name ?? '', memo: `(top-level AccountRef) ${(t.PrivateNote ?? '').slice(0, 100)}`, lineDesc: '', otherAccounts: [...others], linked: [] });
        }
      }
    }
    ledger.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
    let run = 0;
    console.log(`\n  --- ${ledger.length} line(s) on 2145 since ${SINCE} (credit = liability up) ---`);
    for (const r of ledger) {
      run += r.signedToAccount;
      console.log(`  ${r.date} ${r.type.padEnd(13)} #${(r.doc || r.txnId).padEnd(12)} ${r.posting.padEnd(6)} ${r.amount.toFixed(2).padStart(10)} run=${run.toFixed(2).padStart(11)} who="${r.who}" other=[${r.otherAccounts.join('|')}] ${r.memo || r.lineDesc}`);
    }

    // 2. Medisca vendor documents in the window.
    const vendorTxns: VendorTxn[] = [];
    for (const type of ['Bill', 'VendorCredit', 'BillPayment', 'Purchase'] as const) {
      const txns = await qbQueryAll<QbTxn>(location, type, `WHERE TxnDate >= '${SINCE}'`);
      for (const t of txns) {
        const vid = t.VendorRef?.value ?? t.EntityRef?.value;
        if (!vid || !vendorIds.has(vid)) continue;
        vendorTxns.push({
          entity: location, type, txnId: t.Id, doc: t.DocNumber ?? '', date: t.TxnDate ?? '', total: t.TotalAmt ?? 0, balance: t.Balance ?? null,
          memo: (t.PrivateNote ?? '').slice(0, 120),
          lines: (t.Line ?? []).filter((l) => l.DetailType !== 'SubTotalLineDetail').map((l) => ({ account: lineAccount(l)?.name ?? '', item: l.ItemBasedExpenseLineDetail?.ItemRef?.name ?? '', amount: l.Amount ?? 0, desc: (l.Description ?? '').slice(0, 80) })),
          linked: (t.Line ?? []).flatMap((l) => (l.LinkedTxn ?? []).map((x) => `${x.TxnType}:${x.TxnId}`)),
          payAccount: t.CheckPayment?.BankAccountRef?.name ?? t.AccountRef?.name ?? '',
        });
      }
    }
    vendorTxns.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`\n  --- ${vendorTxns.length} Medisca vendor document(s) since ${SINCE} ---`);
    for (const v of vendorTxns) {
      const acctsSummary = [...new Set(v.lines.map((l) => l.account || l.item))].join('|');
      console.log(`  ${v.date} ${v.type.padEnd(12)} #${v.doc.padEnd(12)} total=${v.total.toFixed(2).padStart(10)} bal=${v.balance === null ? '   -   ' : v.balance.toFixed(2).padStart(9)} [${acctsSummary}] ${v.payAccount ? `pay=${v.payAccount} ` : ''}${v.linked.length ? `linked=${v.linked.join(',')} ` : ''}${v.memo}`);
    }
    writeFileSync(join(OUT_ROOT, `${tag}-2145-ledger.json`), JSON.stringify({ account: acct, vendors, ledger, vendorTxns }, null, 2));
  }
  process.exit(0);
}

void main().catch((err) => { console.error(err); process.exit(1); });
