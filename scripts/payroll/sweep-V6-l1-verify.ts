/** READ-ONLY — V6 verifier for L1-01 (Webb), L1-02 (Poland), L1-03 (Freebeck).
 * Re-pulls the specific QBO Purchase/JE records each finding cites by Id/DocNumber and checks
 * for anything the findings might have missed (a later reclass, a 2110 Poland line, the Webb
 * $450 landing spot).
 *   npx tsx scripts/payroll/sweep-V6-l1-verify.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: QbLineDetail;
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
}
interface QbTxn { Id: string; DocNumber?: string; TxnDate?: string; EntityRef?: { name?: string }; PrivateNote?: string; Line?: QbLine[] }

function dump(label: string, txns: QbTxn[]): void {
  console.log(`\n--- ${label} (${txns.length}) ---`);
  for (const t of txns) {
    console.log(`Id=${t.Id} DocNumber=${t.DocNumber ?? '(none)'} TxnDate=${t.TxnDate} PrivateNote="${t.PrivateNote ?? ''}"`);
    for (const l of t.Line ?? []) {
      const acct = l.JournalEntryLineDetail?.AccountRef?.name ?? l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '(no acct)';
      const side = l.JournalEntryLineDetail?.PostingType ?? '';
      console.log(`   ${side.padEnd(6)} ${String(l.Amount).padStart(10)}  ${acct}  memo="${l.Description ?? ''}"`);
    }
  }
}

async function main(): Promise<void> {
  // ---- L1-01 Webb: FL Purchases 31628, 34031 + the four PR-10.* JEs ----
  const flPurch = await qbQueryAll<QbTxn>('MedRock FL' as Entity, 'Purchase', `WHERE Id IN ('31628','34031')`);
  dump('L1-01 FL Purchase 31628, 34031 (Webb loans)', flPurch);

  const flJe2024 = await qbQueryAll<QbTxn>('MedRock FL' as Entity, 'JournalEntry', `WHERE TxnDate >= '2024-10-01' AND TxnDate <= '2024-11-01'`);
  const webbJe = flJe2024.filter((j) => (j.Line ?? []).some((l) => /webb/i.test(l.Description ?? '')));
  dump('L1-01 FL JEs Oct 2024 mentioning Webb', webbJe);

  // Did anything AFTER 2024-10-25 touch 1215 or 2110 for Webb (name-matched)?
  const flAllSince = await qbQueryAll<QbTxn>('MedRock FL' as Entity, 'JournalEntry', `WHERE TxnDate >= '2024-10-26'`);
  const webbLater = flAllSince.filter((j) => (j.Line ?? []).some((l) => /webb/i.test(l.Description ?? '')));
  dump('L1-01 FL JEs after 2024-10-25 mentioning Webb (should be empty if truly stranded)', webbLater);

  // FL 2110 activity Jan 2025 (does the $450 land anywhere identifiable?)
  const flJan2025 = await qbQueryAll<QbTxn>('MedRock FL' as Entity, 'JournalEntry', `WHERE TxnDate >= '2025-01-01' AND TxnDate <= '2025-01-31'`);
  const fl2110Jan = flJan2025.filter((j) => (j.Line ?? []).some((l) => /payroll withholdings/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? '')));
  console.log(`\n--- L1-01 FL 2110 (Payroll Withholdings) JE count Jan 2025: ${fl2110Jan.length} ---`);
  for (const j of fl2110Jan) {
    console.log(`Id=${j.Id} DocNumber=${j.DocNumber} TxnDate=${j.TxnDate}`);
    for (const l of j.Line ?? []) {
      if (/payroll withholdings/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? '')) {
        console.log(`   ${l.JournalEntryLineDetail?.PostingType} ${l.Amount} memo="${l.Description ?? ''}"`);
      }
    }
  }
  const webb450 = flJan2025.filter((j) => (j.Line ?? []).some((l) => /450|webb/i.test(l.Description ?? '')));
  dump('L1-01 FL Jan 2025 JEs mentioning "450" or "Webb" in any line memo', webb450);

  // ---- L1-02 Poland: confirm no TN 2110/1215 reclass line mentions Poland anywhere, any date ----
  const tnAll = await qbQueryAll<QbTxn>('MedRock TN' as Entity, 'JournalEntry', `WHERE TxnDate >= '2025-01-01'`);
  const polandJe = tnAll.filter((j) => (j.Line ?? []).some((l) => /poland/i.test(l.Description ?? '')));
  dump('L1-02 TN JEs (any date since 2025-01-01) mentioning Poland', polandJe);

  const eeAdvAdj = tnAll.filter((j) => j.DocNumber === 'EE Adv Adj 2025.13');
  dump('L1-02/K06 TN JE "EE Adv Adj 2025.13"', eeAdvAdj);

  // ---- L1-03 Freebeck: JE 15119 and 15282, and PR 2025.11.07 ----
  const tnBills15119 = await qbQueryAll<QbTxn>('MedRock TN' as Entity, 'JournalEntry', `WHERE Id IN ('15119','15282','15275')`);
  dump('L1-03 TN JE Ids 15119, 15282, 15275 (Freebeck duplicate)', tnBills15119);

  // Any reversal/deletion trace since 2025-11-13 touching these three?
  const freebeckLater = tnAll.filter((j) => (j.Line ?? []).some((l) => /freebeck/i.test(l.Description ?? '')) && (j.TxnDate ?? '') > '2025-11-13');
  dump('L1-03 TN JEs after 2025-11-13 mentioning Freebeck (should be empty if unresolved)', freebeckLater);
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
