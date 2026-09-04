/** READ-ONLY: (a) what exactly is tagged on unposted drafts #59 and #2093 (they feed the
 *  pool as DraftJE lines with stored tags); (b) any OTHER March-2026 QB JE with inter-entity
 *  Due-to/Due-from lines — an allocation fingerprint the doc-name regex could have missed.
 *  No writes. Untracked scratch. */
import '../lib/load-env';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { getRdsPool } from '../../src/lib/rds';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import type { RawJournalEntry } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const rds = getRdsPool();
  console.log('=== a. Tagged lines on unposted drafts #59 and #2093, with source depts ===');
  const { rows } = await rds.query<{ header_id: number; entity: string; posting_type: string; amount: string; account_name: string; class_name: string | null; department_name: string | null; memo: string | null; depts: string[] | null }>(
    `SELECT l.header_id, h.entity, l.posting_type, l.amount::text AS amount, l.account_name,
            l.class_name, l.department_name, l.memo,
            (SELECT array_agg(DISTINCT ph.home_department)
               FROM source.payroll_history ph WHERE ph.row_key = ANY(l.source_row_keys)) AS depts
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE l.header_id IN (59, 2093)
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
      ORDER BY l.header_id`);
  for (const r of rows) {
    console.log(`  #${r.header_id} ${r.entity} ${r.posting_type} ${money(Number(r.amount))} ${r.account_name} [cls=${r.class_name ?? '-'} dept=${r.department_name ?? '-'}] depts=${(r.depts ?? []).join(',')} ${r.memo ?? ''}`);
  }

  console.log('\n=== b. March 2026 QB JEs with Due-to/Due-from lines (allocation fingerprint) ===');
  const where = `WHERE TxnDate >= '2026-03-01' AND TxnDate <= '2026-03-31'`;
  for (const entity of EOM_ENTITIES) {
    const jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
    for (const j of jes) {
      const ie = (j.Line ?? []).filter((l) => /^due (to|from)/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
      if (ie.length === 0) continue;
      const dr = (j.Line ?? []).reduce((s, l) => s + (l.JournalEntryLineDetail?.PostingType === 'Debit' ? (l.Amount ?? 0) : 0), 0);
      console.log(`  ${entity}  QB Id ${j.Id}  ${j.TxnDate}  ${j.DocNumber ?? '(no doc)'}  Dr ${money(dr)}  IE lines: ${ie.length}`);
    }
  }
  await rds.end();
  process.exit(0);
}
void main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
