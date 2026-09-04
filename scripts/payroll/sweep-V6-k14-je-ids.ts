/** READ-ONLY — V6 verifier. Resolve TN JournalEntry Ids 20698,20699,20700,20702 (the K14 row
 * in KNOWN-ISSUES.md cites these as "JE 20702, 20699, 20698, 20700"). Query QBO TN JournalEntry
 * directly by internal Id field and print Id, DocNumber, TxnDate, total, and each line's account
 * + name + amount, to determine whether K14's citation is an Id-vs-DocNumber confusion.
 *   npx tsx scripts/payroll/sweep-V6-k14-je-ids.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: QbLineDetail;
  Id?: string;
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; Line?: QbLine[] }

async function main(): Promise<void> {
  const ids = ['20698', '20699', '20700', '20702'];
  const all = await qbQueryAll<QbJe>('MedRock TN', 'JournalEntry', `WHERE TxnDate >= '2026-01-01'`);
  console.log(`Pulled ${all.length} TN JournalEntry rows since 2026-01-01`);
  for (const id of ids) {
    const je = all.find((j) => j.Id === id);
    if (!je) {
      console.log(`\nId ${id}: NOT FOUND in TN JournalEntry since 2026-01-01 (widening search)`);
      continue;
    }
    console.log(`\nId ${id}  DocNumber=${je.DocNumber ?? '(none)'}  TxnDate=${je.TxnDate}  TotalAmt=${je.TotalAmt}`);
    for (const l of je.Line ?? []) {
      const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? '(no account)';
      const side = l.JournalEntryLineDetail?.PostingType ?? '';
      console.log(`   ${side.padEnd(6)} ${String(l.Amount).padStart(10)}  ${acct}  memo="${l.Description ?? ''}"`);
    }
  }

  // Widen: also check ALL TxnDates (no date filter) in case these predate 2026.
  const notFound = ids.filter((id) => !all.find((j) => j.Id === id));
  if (notFound.length > 0) {
    const wide = await qbQueryAll<QbJe>('MedRock TN', 'JournalEntry', `WHERE Id IN ('${notFound.join("','")}')`);
    console.log(`\n--- Widened query (no date filter) WHERE Id IN (${notFound.join(',')}) ---`);
    console.log(`Returned ${wide.length} rows`);
    for (const je of wide) {
      console.log(`\nId ${je.Id}  DocNumber=${je.DocNumber ?? '(none)'}  TxnDate=${je.TxnDate}  TotalAmt=${je.TotalAmt}`);
      for (const l of je.Line ?? []) {
        const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? '(no account)';
        const side = l.JournalEntryLineDetail?.PostingType ?? '';
        console.log(`   ${side.padEnd(6)} ${String(l.Amount).padStart(10)}  ${acct}  memo="${l.Description ?? ''}"`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
