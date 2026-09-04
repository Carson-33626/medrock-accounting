/**
 * READ-ONLY (books sweep L7). CORRECTS sweep-L7-fringe-wide.ts, which matched account names by
 * exact string against the Account entity's plain `.Name` ("Employee Fringe Benefits") and found
 * zero transaction lines anywhere. sweep-V2-aetna-broad-search.ts's output shows real lines whose
 * AccountRef.name is "Payroll Expense -:Employee Fringe Benefits" — QBO's fully-qualified
 * parent:child form for a sub-account (the exact "account names exist in two forms" trap called
 * out in the books-sweep DS §5). This probe matches on EITHER form (exact plain name, or fully-
 * qualified name ending in ":Employee Fringe Benefits") across JournalEntry/Bill/Purchase/
 * VendorCredit/Deposit, all three entities, since 2024-01-01, and reports every hit found.
 *
 *   npx tsx scripts/payroll/sweep-L7-fringe-qualified-name.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const FRINGE_RE = /(^employee fringe benefits$)|(:employee fringe benefits$)/i;

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; EntityRef?: { name?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n========================= ${entity} =========================`);
    let total = 0, hits = 0;
    for (const type of ['JournalEntry', 'Bill', 'Purchase', 'VendorCredit', 'Deposit']) {
      const txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '2024-01-01' ORDER BY TxnDate ASC`);
      for (const t of txns) {
        for (const l of t.Line ?? []) {
          const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
          const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
          const acct = jeAcct ?? expAcct ?? '';
          if (!FRINGE_RE.test(acct)) continue;
          hits++;
          const side = jeAcct ? l.JournalEntryLineDetail?.PostingType : 'Debit';
          const amt = l.Amount ?? 0;
          total += side === 'Debit' ? amt : -amt;
          console.log(`  ${t.TxnDate}  ${type.padEnd(12)} ${(t.DocNumber ?? t.Id ?? '?').padEnd(20)} ${(side ?? '?').padEnd(6)} ${money(amt).padStart(10)}  acct="${acct}"  desc=${JSON.stringify(l.Description ?? '')}`);
        }
      }
    }
    console.log(`  --- total lines found: ${hits}, net Dr ${money(total)}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
