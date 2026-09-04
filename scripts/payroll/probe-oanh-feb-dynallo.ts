/**
 * READ-ONLY (Carson, 2026-08-25, part 4 of the Oanh Nguyen review): February 2026. Barbara's
 * FL Feb payroll JEs carry Dr $14,218.63 classed 'Allocate - TX' (her lines included) but no
 * FL-side credit moves them out. Does `DynAlloAdj 2026.02` (or anything else, either book,
 * Feb..Aug) actually move Feb marketing cost FL->TX? Print the full lines of every JE in FL
 * and TX whose doc contains 'DynAllo', plus any FL JE 2026-02..2026-08 that CREDITS a
 * marketing account with class 'Allocate - TX' (the shape an FL->TX sweep would have).
 *
 *   npx tsx scripts/payroll/probe-oanh-feb-dynallo.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import type { Entity } from '../../src/lib/payroll/types';

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

function printJe(entity: Entity, j: QbJe): void {
  console.log(`\n--- [${entity}] ${j.TxnDate}  ${j.DocNumber ?? `(id ${j.Id})`}`);
  if (j.PrivateNote) console.log(`    note: ${j.PrivateNote.slice(0, 200)}`);
  for (const l of j.Line ?? []) {
    const d = l.JournalEntryLineDetail;
    if (!d || typeof l.Amount !== 'number') continue;
    const dims = [d.DepartmentRef?.name, d.ClassRef?.name].filter((x): x is string => !!x).join(' / ');
    console.log(`    ${d.PostingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.Amount).padStart(12)}  ${d.AccountRef?.name ?? '?'}${dims ? `  [${dims}]` : ''}  ${l.Description ?? ''}`);
  }
}

async function main(): Promise<void> {
  for (const entity of ['MedRock FL', 'MedRock TX'] as Entity[]) {
    const jes = await qbQueryAll<QbJe>(
      entity, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-08-25'`,
    );
    const dyn = jes.filter((j) => /dynallo/i.test(j.DocNumber ?? ''));
    console.log(`\n=== ${entity}: ${dyn.length} DynAllo JEs ===`);
    for (const j of dyn) printJe(entity, j);

    if (entity === 'MedRock FL') {
      const sweeps = jes.filter((j) =>
        !/dynallo/i.test(j.DocNumber ?? '') &&
        (j.TxnDate ?? '') >= '2026-02-01' &&
        (j.Line ?? []).some((l) => {
          const d = l.JournalEntryLineDetail;
          return d?.PostingType === 'Credit'
            && /marketing|commission/i.test(d.AccountRef?.name ?? '')
            && /allocate\s*-\s*tx/i.test(d.ClassRef?.name ?? '');
        }),
      );
      console.log(`\n=== MedRock FL: JEs since Feb CREDITING marketing/commission with class Allocate - TX — ${sweeps.length} ===`);
      for (const j of sweeps) printJe(entity, j);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
