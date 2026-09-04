/** READ-ONLY: list every revenue-rule pool line with a 'PR '-prefixed doc for Apr + Aug,
 *  with account + doc + txn id, to pin down the non-CS leaks. Untracked scratch. */
import './load-env-vercel-first';
import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  for (const month of [4, 8]) {
    const { pool } = await fetchAllocationPool({ year: 2026, month });
    const cs = pool.filter((l) => l.rule === 'revenue' && /^PR /.test(l.docNumber ?? ''));
    console.log(`\n=== 2026-${String(month).padStart(2, '0')}: ${cs.length} revenue 'PR' lines ===`);
    for (const l of cs.sort((a, b) => (a.docNumber ?? '').localeCompare(b.docNumber ?? '') || a.accountName.localeCompare(b.accountName))) {
      console.log(`  ${l.entity.padEnd(12)} ${l.txnType.padEnd(12)} ${(l.docNumber ?? '-').padEnd(26)} txnId=${l.txnId.padEnd(10)} ${money(l.amount).padStart(13)}  ${l.accountName}  [cls=${l.className ?? '-'} dept=${l.departmentName ?? '-'}]`);
    }
  }
  process.exit(0);
}
void main().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
