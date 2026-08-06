/**
 * READ-ONLY: investigate why MedRock TX has no 'PR 2026.03.27' payroll JE. Lists every
 * JournalEntry for TX with TxnDate between 2026-03-20 and 2026-04-10 (DocNumber, TxnDate,
 * line count, total, PrivateNote) to see whether TX payroll was posted under a different
 * DocNumber, folded into another entity's JE, or genuinely absent.
 *   npx tsx scripts/payroll/probe-tx-missing-je.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine { Amount?: number; JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit' } }
interface QbJournalEntry {
  Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; TotalAmt?: number; Line?: QbLine[];
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');
  console.log('================ MedRock TX — JournalEntry, TxnDate 2026-03-20..2026-04-10 ================');
  const entries = await qbQueryAll<QbJournalEntry>(
    'MedRock TX',
    'JournalEntry',
    `WHERE TxnDate >= '2026-03-20' AND TxnDate <= '2026-04-10' ORDER BY TxnDate ASC`,
  );
  console.log(`  ${entries.length} JEs in range`);
  for (const je of entries) {
    let dr = 0, cr = 0;
    for (const l of je.Line ?? []) {
      const amt = l.Amount ?? 0;
      if (l.JournalEntryLineDetail?.PostingType === 'Debit') dr += amt; else if (l.JournalEntryLineDetail?.PostingType === 'Credit') cr += amt;
    }
    console.log(
      `   ${je.TxnDate}  #${je.DocNumber ?? je.Id}  lines:${(je.Line ?? []).length}  Dr:${dr.toFixed(2)} Cr:${cr.toFixed(2)}  note:"${(je.PrivateNote ?? '').slice(0, 80)}"`,
    );
  }

  // Also check: does any OTHER entity's JE around this date reference TX (e.g. inter-entity,
  // "IE" suffix in DocNumber, or a PrivateNote mentioning TX/Austin)?
  console.log('\n================ Cross-check: FL/TN JEs in range mentioning TX/Austin ================');
  for (const location of ['MedRock FL', 'MedRock TN'] as const) {
    const all = await qbQueryAll<QbJournalEntry>(
      location,
      'JournalEntry',
      `WHERE TxnDate >= '2026-03-20' AND TxnDate <= '2026-04-10' ORDER BY TxnDate ASC`,
    );
    const hits = all.filter((je) => /tx|austin/i.test(je.PrivateNote ?? '') || /tx|austin/i.test(je.DocNumber ?? ''));
    console.log(`  ${location}: ${all.length} JEs in range, ${hits.length} mention TX/Austin in DocNumber/PrivateNote`);
    for (const je of hits) {
      console.log(`    ${je.TxnDate}  #${je.DocNumber ?? je.Id}  note:"${(je.PrivateNote ?? '').slice(0, 80)}"`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
