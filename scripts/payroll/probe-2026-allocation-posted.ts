/** READ-ONLY: has any month-end allocation entry actually been POSTED for 2026?
 *
 *  CS wages turn out to be tagged `Allocate - %` on Barbara's posted QB payroll JEs, so they
 *  DO enter the pool. That is separate from whether the allocation entry that redistributes
 *  the pool was ever booked. This lists every 2026 QB JournalEntry whose DocNumber looks like
 *  an allocation, plus the local allocation headers and their status.
 *
 *  No writes. Untracked scratch.
 */
import '../lib/load-env';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { getRdsPool } from '../../src/lib/rds';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import type { RawJournalEntry } from '../../src/lib/payroll/qb-pool';

interface HeaderRow {
  id: number; entity: string; pay_date: string; doc_number: string | null;
  status: string; kind: string; total_debits: string;
}

const ALLOC_DOC_RE = /(allo|allocation|rev adj)/i;

async function main(): Promise<void> {
  const year = process.argv[2] ?? '2026';
  const where = `WHERE TxnDate >= '${year}-01-01' AND TxnDate <= '${year}-12-31'`;

  console.log(`\n=== QB JournalEntries in ${year} with an allocation-looking DocNumber ===`);
  for (const entity of EOM_ENTITIES) {
    let jes: RawJournalEntry[];
    try {
      jes = await qbQueryAll<RawJournalEntry>(entity, 'JournalEntry', where);
    } catch (err) {
      console.log(`  !! ${entity}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const hits = jes.filter((j) => ALLOC_DOC_RE.test(j.DocNumber ?? ''));
    console.log(`  ${entity}: ${hits.length} of ${jes.length} JEs`);
    for (const j of hits.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
      const total = (j.Line ?? []).reduce(
        (s, l) => s + (l.JournalEntryLineDetail?.PostingType === 'Debit' ? (l.Amount ?? 0) : 0), 0,
      );
      console.log(`      ${j.TxnDate}  ${j.DocNumber}  Dr $${total.toFixed(2)}  (${(j.Line ?? []).length} lines)`);
    }
  }

  console.log(`\n=== local allocation headers (accounting.payroll_journal_headers kind='allocation') ===`);
  const pool = getRdsPool();
  const rows = await pool.query<HeaderRow>(
    `SELECT id, entity, pay_date, qb_doc_number AS doc_number, status, kind, COALESCE(total_debits,0)::text AS total_debits
       FROM accounting.payroll_journal_headers
      WHERE kind = 'allocation' AND pay_date LIKE '%/${year}'
      ORDER BY to_date(pay_date, 'MM/DD/YYYY'), entity`,
  );
  if (rows.rows.length === 0) console.log('  (none)');
  for (const r of rows.rows) {
    console.log(`  ${r.pay_date}  ${r.entity.padEnd(12)} ${(r.doc_number ?? '-').padEnd(24)} status=${r.status.padEnd(12)} Dr $${Number(r.total_debits).toFixed(2)}`);
  }

  await pool.end();
  process.exit(0);
}

void main();
