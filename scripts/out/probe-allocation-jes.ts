// Read-only probe: locate Amy's manual month-end allocation JEs in each QB company.
// 1) Lists Department + Class names (looking for the "Allocate" flag naming).
// 2) Pulls JournalEntries since 2025-10-01 and prints any whose lines carry an
//    Allocate-ish department or class, with full leg detail (account, dept, class,
//    posting, amount, memo) so the generator can mirror the real structure.
import '../ramp-split-push/load-env';
import { qbQueryAll, type Location } from '../../src/lib/quickbooks-multi';

interface NamedEntity { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }

interface QbRef { value?: string; name?: string }
interface JeLineDetail {
  PostingType?: 'Debit' | 'Credit';
  AccountRef?: QbRef;
  DepartmentRef?: QbRef;
  ClassRef?: QbRef;
}
interface JeLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: JeLineDetail;
}
interface JournalEntry {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  Line?: JeLine[];
}

const LOCATIONS: Location[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
const ALLOC_RE = /alloc/i;

async function main(): Promise<void> {
  for (const loc of LOCATIONS) {
    console.log(`\n========== ${loc} ==========`);
    try {
      const depts = await qbQueryAll<NamedEntity>(loc, 'Department', '');
      const classes = await qbQueryAll<NamedEntity>(loc, 'Class', '');
      console.log('Departments:', depts.map((d) => d.FullyQualifiedName ?? d.Name).join(' | '));
      console.log('Classes:', classes.map((c) => c.FullyQualifiedName ?? c.Name).join(' | '));

      const jes = await qbQueryAll<JournalEntry>(loc, 'JournalEntry', "WHERE TxnDate >= '2025-10-01'");
      console.log(`JournalEntries since 2025-10-01: ${jes.length}`);
      for (const je of jes) {
        const lines = je.Line ?? [];
        const hit = lines.some((l) => {
          const d = l.JournalEntryLineDetail;
          return ALLOC_RE.test(d?.DepartmentRef?.name ?? '') || ALLOC_RE.test(d?.ClassRef?.name ?? '');
        });
        const docHit = ALLOC_RE.test(je.DocNumber ?? '') || ALLOC_RE.test(je.PrivateNote ?? '');
        if (!hit && !docHit) continue;
        console.log(`\n--- JE Id=${je.Id} Doc="${je.DocNumber ?? ''}" TxnDate=${je.TxnDate} Note="${je.PrivateNote ?? ''}"`);
        for (const l of lines) {
          const d = l.JournalEntryLineDetail;
          console.log(
            `    ${d?.PostingType ?? '?'} ${String(l.Amount ?? 0).padStart(12)}  acct="${d?.AccountRef?.name ?? ''}"  dept="${d?.DepartmentRef?.name ?? ''}"  class="${d?.ClassRef?.name ?? ''}"  memo="${l.Description ?? ''}"`,
          );
        }
      }
    } catch (err) {
      console.error(`ERROR for ${loc}:`, err instanceof Error ? err.message : err);
    }
  }
  process.exit(0);
}

void main();
