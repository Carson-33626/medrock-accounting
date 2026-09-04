/**
 * READ-ONLY (books sweep V2 verification of L2-04). Search FL and TX 2026 JournalEntry records
 * for anything mentioning Nguyen / Oanh / position 000717 / position 000714 / "TX reclass" in
 * DocNumber, PrivateNote, or line Description, to check whether Barbara's manual JEs already
 * moved the FL-era EE+ER tax sized by L2-04 before treating it as still-open.
 *
 *   cd web && npx tsx scripts/payroll/sweep-V2-nguyen-je-search.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ENTITIES: Entity[] = ['MedRock FL', 'MedRock TX'];
const RE = /nguyen|oanh|000717|000714|tx\s*reclass/i;

interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string; value?: string }; Entity?: { EntityRef?: { name?: string } } };
}
interface QbTxn {
  Id?: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number; PrivateNote?: string;
  Line?: QbLine[];
}

async function main(): Promise<void> {
  for (const entity of ENTITIES) {
    console.log(`\n\n========================= ${entity} =========================`);
    const jes = await qbQueryAll<QbTxn>(entity, 'JournalEntry', `WHERE TxnDate >= '2025-01-01' ORDER BY TxnDate ASC`);
    const hits = jes.filter((j) => {
      const doc = j.DocNumber ?? '';
      const note = j.PrivateNote ?? '';
      const lineHit = (j.Line ?? []).some((l) => RE.test(l.Description ?? ''));
      return RE.test(doc) || RE.test(note) || lineHit;
    });
    console.log(`-- JournalEntry (2025-01-01 -> today) matching /nguyen|oanh|000717|000714|tx reclass/i: ${hits.length} --`);
    for (const j of hits) {
      console.log(`  ${j.TxnDate}  #${j.DocNumber}  Id=${j.Id}  Total=${money(j.TotalAmt ?? 0)}  PrivateNote=${JSON.stringify(j.PrivateNote ?? '')}`);
      for (const l of j.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        if (RE.test(l.Description ?? '') || hits.length < 30) {
          console.log(`      ${(d?.PostingType ?? '?').padEnd(6)} ${money(l.Amount ?? 0).padStart(12)}  ${(d?.AccountRef?.name ?? '?').padEnd(40)} desc=${JSON.stringify(l.Description ?? '')}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
