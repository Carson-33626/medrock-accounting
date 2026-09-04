/**
 * READ-ONLY (books sweep V2 verification of L7-02/L7-03). The L7 probes searched JournalEntry
 * DocNumber against /aetna\s*2026/i, which misses DocNumbers like "Aetna 03.2026 Alloc" (date
 * reversed, extra token in between "aetna" and "2026"). L2-03's evidence table cites exactly such
 * a JE for TX (#1926 "Aetna 03.2026 Alloc"). This probe does a BROAD case-insensitive search for
 * "aetna" anywhere in DocNumber, PrivateNote, or any line Description, across all 2026 JournalEntry
 * records in all three entities, to check whether L7-02 ("TN's JE stopped after February") and
 * L7-03 ("TX has never posted an Aetna JE") hold up against a wider net.
 *
 *   cd web && npx tsx scripts/payroll/_sweep-V2-aetna-broad-search.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string; value?: string } };
}
interface QbTxn {
  Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; PrivateNote?: string;
  Line?: QbLine[];
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n\n========================= ${entity} =========================`);
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);
    const hits = jes.filter((j) => {
      const doc = (j.DocNumber ?? '').toLowerCase();
      const note = (j.PrivateNote ?? '').toLowerCase();
      const lineHit = (j.Line ?? []).some((l) => /aetna/i.test(l.Description ?? ''));
      return doc.includes('aetna') || note.includes('aetna') || lineHit;
    });
    console.log(`-- ALL JournalEntry (2026) with "aetna" ANYWHERE (DocNumber, PrivateNote, or any line Description): ${hits.length} --`);
    for (const j of hits) {
      console.log(`  ${j.TxnDate}  #${j.DocNumber}  Id=${j.Id}  Total=${money(j.TotalAmt ?? 0)}  PrivateNote=${JSON.stringify(j.PrivateNote ?? '')}`);
      for (const l of j.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        console.log(`      ${(d?.PostingType ?? '?').padEnd(6)} ${money(l.Amount ?? 0).padStart(12)}  ${(d?.AccountRef?.name ?? '?').padEnd(40)} desc=${JSON.stringify(l.Description ?? '')}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
