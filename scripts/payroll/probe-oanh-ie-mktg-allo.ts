/**
 * READ-ONLY (Carson, 2026-08-25, part 3 of the Oanh Nguyen review): before concluding her
 * FL-era cost never reached Texas, inspect the manual marketing-allocation JEs Barbara
 * posted in FL (docs 'IE Mktg Allo ...', 'IE Mktg Dir PR ...', 'PR Split ...', 'CSR ...',
 * 'PR Allo ...', 'FL-TN Rev Adj ...') across 2025-07..2026-03 — full line detail: accounts,
 * classes, departments, descriptions, amounts. Does anything route marketing cost to TX
 * (Due to/from TX, TX-named lines, Houston mentions)?
 *
 *   npx tsx scripts/payroll/probe-oanh-ie-mktg-allo.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbJeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbJeLine[] }

async function main(): Promise<void> {
  const jes = await qbQueryAll<QbJe>(
    'MedRock FL', 'JournalEntry', `WHERE TxnDate >= '2025-07-01' AND TxnDate <= '2026-03-31'`,
  );
  const interesting = jes.filter((j) => {
    const doc = (j.DocNumber ?? '').trim();
    return /mktg|marketing|allo|split|rev adj/i.test(doc);
  });
  console.log(`=== ${interesting.length} allocation/split-looking FL JEs, 2025-07..2026-03 ===`);
  for (const j of interesting.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
    const txRelated = (j.Line ?? []).some((l) =>
      /\bTX\b|texas|houston/i.test(
        `${l.Description ?? ''} ${l.JournalEntryLineDetail?.AccountRef?.name ?? ''} ${l.JournalEntryLineDetail?.ClassRef?.name ?? ''} ${l.JournalEntryLineDetail?.DepartmentRef?.name ?? ''}`,
      ),
    );
    const mktg = (j.Line ?? []).some((l) => /marketing|commission/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
    console.log(`\n--- ${j.TxnDate}  ${j.DocNumber ?? `(id ${j.Id})`}  ${txRelated ? '[TX-RELATED]' : ''}${mktg ? '[MKTG]' : ''}`);
    if (j.PrivateNote) console.log(`    note: ${j.PrivateNote.slice(0, 160)}`);
    if (!txRelated && !mktg) { console.log('    (no TX or marketing lines — skipped detail)'); continue; }
    for (const l of j.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (!d || typeof l.Amount !== 'number') continue;
      const dims = [d.DepartmentRef?.name, d.ClassRef?.name].filter((x): x is string => !!x).join(' / ');
      console.log(`    ${d.PostingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.Amount).padStart(12)}  ${d.AccountRef?.name ?? '?'}${dims ? `  [${dims}]` : ''}  ${l.Description ?? ''}`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
