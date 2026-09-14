/** READ-ONLY: every INV OPEN (opening correction) header, any date. */
import './lib/load-env';
import { getRdsPool } from '../src/lib/rds';
interface R { id: string; entity: string; pay_date: string; txn_date: string | null; status: string; qb_doc_number: string | null; qb_entry_id: string | null; total_debits: string; created_at: string | null }
async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<R>(
    `SELECT id, entity, pay_date, to_char(txn_date,'YYYY-MM-DD') AS txn_date, status, qb_doc_number, qb_entry_id, total_debits::text, to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at
     FROM accounting.payroll_journal_headers WHERE pay_group = 'INV OPEN' ORDER BY pay_date, entity`);
  for (const r of rows) console.log(`${r.id.padStart(6)} ${r.entity.padEnd(12)} pay ${r.pay_date} txn ${r.txn_date} ${r.status.padEnd(12)} ${(r.qb_doc_number ?? '').padEnd(22)} qb=${r.qb_entry_id ?? '-'} $${r.total_debits} created ${r.created_at}`);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
