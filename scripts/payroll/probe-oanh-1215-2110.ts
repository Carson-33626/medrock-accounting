/**
 * READ-ONLY (Carson, 2026-08-25, part 6 of the Oanh Nguyen review): Barbara says 2110
 * (Payroll Withholdings) isn't clearing right for her and 1215 (Employee Advances) is
 * mis-mapped. QB-side evidence, FL + TX books, 2025-07-01..today:
 *   1. Every JournalEntry line that mentions her (Oanh / Nguyen / Nguyn) — where has
 *      Barbara been booking her by hand?
 *   2. Every JournalEntry line hitting 'Employee Advances' — who feeds 1215 and does
 *      anything reference her?
 *   3. The MEDICAL - ER / CAR ALLOWANCE account-map rules for MARKET vs other cost
 *      centers (from RDS) — what makes marketers special.
 *
 *   npx tsx scripts/payroll/probe-oanh-1215-2110.ts
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
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

async function main(): Promise<void> {
  for (const entity of ['MedRock FL', 'MedRock TX'] as Entity[]) {
    const jes = await qbQueryAll<QbJe>(
      entity, 'JournalEntry', `WHERE TxnDate >= '2025-07-01' AND TxnDate <= '2026-08-25'`,
    );

    console.log(`\n================ ${entity} (${jes.length} JEs scanned) ================`);

    console.log(`\n--- lines mentioning her by name ---`);
    let nameHits = 0;
    for (const j of jes) {
      for (const l of j.Line ?? []) {
        if (!/oanh|nguyen|nguyn/i.test(l.Description ?? '')) continue;
        const d = l.JournalEntryLineDetail;
        nameHits++;
        console.log(`  ${j.TxnDate}  ${(j.DocNumber ?? `(id ${j.Id})`).padEnd(22)} ${d?.PostingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.Amount ?? 0).padStart(11)}  ${d?.AccountRef?.name ?? '?'}  ${l.Description ?? ''}`);
      }
    }
    if (nameHits === 0) console.log('  (none)');

    console.log(`\n--- lines hitting 'Employee Advances' ---`);
    let advHits = 0;
    for (const j of jes) {
      for (const l of j.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        if (!/employee advance/i.test(d?.AccountRef?.name ?? '')) continue;
        advHits++;
        console.log(`  ${j.TxnDate}  ${(j.DocNumber ?? `(id ${j.Id})`).padEnd(22)} ${d?.PostingType === 'Debit' ? 'Dr' : 'Cr'} ${money(l.Amount ?? 0).padStart(11)}  ${l.Description ?? ''}`);
      }
    }
    if (advHits === 0) console.log('  (none)');
  }

  console.log(`\n================ account-map: MEDICAL - ER and CAR ALLOWANCE rules ================`);
  const { rows } = await getRdsPool().query<{ entity: Entity; adp_column: string; cost_center: string; account_name: string; posting_type: string; credit_bucket: string | null; active: boolean; memo: string | null; updated_at: string }>(
    `SELECT entity, adp_column, cost_center, account_name, posting_type, credit_bucket, active, memo, updated_at::text
     FROM accounting.payroll_account_map
     WHERE adp_column IN ('MEDICAL - ER', 'CAR ALLOWANCE - EARNING') AND active
     ORDER BY adp_column, entity, cost_center, posting_type`,
  );
  for (const r of rows) {
    console.log(`  ${r.adp_column.padEnd(24)} ${r.entity.padEnd(11)} cc=${r.cost_center.padEnd(7)} ${r.posting_type.padEnd(6)} ${r.account_name}${r.credit_bucket ? ` (${r.credit_bucket})` : ''}${r.memo ? `  memo: ${r.memo}` : ''}`);
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
