/**
 * READ-ONLY (books sweep L7). Follow-up to sweep-L7-carrier-and-fringe.ts: that probe found the
 * "Employee Fringe Benefits" account at $0.00 CurrentBalance with zero 2026 JE/Bill/Purchase
 * lines in all three entities, contradicting the lane brief's premise that Barbara dumps
 * mismatches there. Widen the transaction-type search (Expense, CreditCardCharge, Check,
 * VendorCredit, Deposit) and also print the account's full life-to-date CurrentBalance context
 * (Classification, SubAccount) to confirm this isn't a account-mapping miss.
 *
 *   npx tsx scripts/payroll/sweep-L7-fringe-wide.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

interface QbAccount { Id?: string; Name?: string; AccountType?: string; AccountSubType?: string; Classification?: string; CurrentBalance?: number; SubAccount?: boolean; ParentRef?: { name?: string } }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
}
interface QbTxn { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; EntityRef?: { name?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n========================= ${entity} =========================`);
    const accounts = await qbQueryAll<QbAccount>(entity, 'Account', '');
    const fringe = accounts.find((a) => /fringe/i.test(a.Name ?? ''));
    if (!fringe) { console.log('  no Fringe account at all'); continue; }
    console.log(`  Account: "${fringe.Name}"  Id=${fringe.Id}  type=${fringe.AccountType}/${fringe.AccountSubType}  classification=${fringe.Classification}  subAccount=${fringe.SubAccount} parent=${fringe.ParentRef?.name ?? ''}  CurrentBalance=${money(fringe.CurrentBalance ?? 0)}`);

    let total = 0, hits = 0;
    for (const type of ['Expense', 'CreditCardCharge', 'Check', 'VendorCredit', 'Deposit', 'JournalEntry', 'Bill', 'Purchase']) {
      let txns: QbTxn[] = [];
      try {
        txns = await qbQueryAll<QbTxn>(entity, type, `WHERE TxnDate >= '2024-01-01' ORDER BY TxnDate ASC`);
      } catch (e) {
        console.log(`  (query type ${type} failed: ${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      for (const t of txns) {
        for (const l of t.Line ?? []) {
          const jeAcct = l.JournalEntryLineDetail?.AccountRef?.name;
          const expAcct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
          const acct = jeAcct ?? expAcct;
          if (!acct || acct !== fringe.Name) continue;
          hits++;
          const side = jeAcct ? l.JournalEntryLineDetail?.PostingType : 'Debit';
          const amt = l.Amount ?? 0;
          total += side === 'Debit' ? amt : -amt;
          console.log(`  ${t.TxnDate}  ${type.padEnd(12)} ${(t.DocNumber ?? t.Id ?? '?').padEnd(14)} ${(side ?? '?').padEnd(6)} ${money(amt).padStart(10)}  vendor=${t.EntityRef?.name ?? ''}  desc=${JSON.stringify(l.Description ?? t.PrivateNote ?? '')}`);
        }
      }
    }
    console.log(`  --- total lines found (any type, since 2024-01-01): ${hits}, net Dr ${money(total)}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
