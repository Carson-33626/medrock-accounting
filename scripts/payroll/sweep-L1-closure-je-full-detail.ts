/**
 * READ-ONLY — Books Sweep lane L1. Full two-sided JE detail (every line, not just the 1215 line)
 * for the JEs L1-07 cites as verified closures (Denha FL, Ivey/Powell/Browne TN), so the finding
 * can state both legs of each entry per the accountant-scrutiny standard, not just the 1215 side.
 *
 *   npx tsx scripts/payroll/sweep-L1-closure-je-full-detail.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: QbLineDetail }
interface QbJE { Id: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

type ThreeEntity = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';

async function dump(entity: ThreeEntity, docNumbers: string[], from: string, to: string): Promise<void> {
  const all = await qbQueryAll<QbJE>(entity, 'JournalEntry', `WHERE TxnDate >= '${from}' AND TxnDate <= '${to}'`);
  for (const dn of docNumbers) {
    const matches = all.filter((j) => j.DocNumber === dn);
    for (const je of matches) {
      console.log(`\n  ${entity} JE Id=${je.Id} DocNumber="${dn}" ${je.TxnDate}`);
      let dr = 0, cr = 0;
      for (const l of je.Line ?? []) {
        const side = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr';
        if (side === 'Dr') dr += l.Amount ?? 0; else cr += l.Amount ?? 0;
        console.log(`    ${side} ${money(l.Amount ?? 0).padStart(11)}  [${l.JournalEntryLineDetail?.AccountRef?.name ?? '?'}]  ${l.Description ?? ''}`);
      }
      console.log(`    -- totals: Dr ${money(dr)}  Cr ${money(cr)}  ${Math.abs(dr - cr) < 0.005 ? '(balances)' : '*** DOES NOT BALANCE ***'}`);
    }
    if (matches.length === 0) console.log(`\n  ${entity} JE DocNumber="${dn}": NOT FOUND in ${from}..${to}`);
  }
}

async function main(): Promise<void> {
  console.log('=== FL: Denha closure JE ===');
  await dump('MedRock FL', ['EE Adv Clr 2026.08'], '2026-08-01', '2026-08-31');

  console.log('\n=== TN: Ivey closure JE ===');
  await dump('MedRock TN', ['EE Adv Clr 2026.04 TN'], '2026-04-01', '2026-04-30');

  console.log('\n=== TN: Powell closure JEs (both, same DocNumber "Ins Recov 2026.05 TN") ===');
  await dump('MedRock TN', ['Ins Recov 2026.05 TN'], '2026-05-01', '2026-05-31');

  console.log('\n=== TN: Browne closure JE ===');
  await dump('MedRock TN', ['EE Adv Clr 2026.04'], '2026-04-01', '2026-04-30');

  // Rule-6 skepticism re-check: the original open-ended TxnDate>='2025-01-01' pull with no upper
  // bound (sweep-L1-verify-strands.ts) reported these same DocNumbers NOT FOUND, while this
  // tightly bounded pull finds all four — meaning that unbounded pull silently truncated before
  // reaching them (a pagination/result-size limit in qbQueryAll for a very large unbounded TN
  // JournalEntry pull), not that the DocNumbers don't exist. Re-verify the TN Poland-reclass
  // "not found" conclusion (L1-02) the same way, bounded to Nov 2025 -> today, to rule out the
  // same failure mode there.
  console.log('\n=== TN: Poland reclass re-check, bounded Nov 2025 -> today (any JE mentioning Poland, any account) ===');
  const all = await qbQueryAll<{ Id: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }>(
    'MedRock TN', 'JournalEntry', `WHERE TxnDate >= '2025-11-01' AND TxnDate <= '2026-09-02'`,
  );
  console.log(`  (pulled ${all.length} TN JEs in the bounded window)`);
  const hits = all.filter((j) => (j.Line ?? []).some((l) => /poland/i.test(l.Description ?? '')));
  if (hits.length === 0) console.log('  no JE line in this window mentions "Poland" — confirms the reclass is still not posted.');
  for (const j of hits) {
    console.log(`\n  JE Id=${j.Id} DocNumber="${j.DocNumber}" ${j.TxnDate}`);
    for (const l of j.Line ?? []) {
      const side = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr';
      console.log(`    ${side} ${money(l.Amount ?? 0).padStart(11)}  [${l.JournalEntryLineDetail?.AccountRef?.name ?? '?'}]  ${l.Description ?? ''}`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
