/** READ-ONLY: confirm the 4/03 + 8/12 rebuilt drafts carry corrected tags. Untracked scratch. */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';

async function main(): Promise<void> {
  const { rows } = await getRdsPool().query<{ id: number; txn: string; entity: string; amount: string; account_name: string; class_name: string | null; department_name: string | null }>(
    `SELECT h.id, h.txn_date::text AS txn, h.entity, l.amount::text AS amount, l.account_name, l.class_name, l.department_name
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE h.kind = 'pay_date' AND h.status <> 'posted' AND h.pay_date IN ('04/03/2026', '08/12/2026')
        AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')
      ORDER BY h.id`);
  if (rows.length === 0) console.log('no Allocate-tagged lines remain on the rebuilt drafts');
  for (const r of rows) console.log(`#${r.id} ${r.txn} ${r.entity} ${r.amount} ${r.account_name} [cls=${r.class_name ?? '-'} dept=${r.department_name ?? '-'}]`);
  process.exit(0);
}
void main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
