/** READ-ONLY: where do the Customer Service pool lines actually come from?
 *
 *  probe-cs-allocation-basis.ts looked at the employee map and the LOCAL unposted drafts and
 *  concluded CS was not pooled. The March dry-run then showed $40,100.61 of Customer Service
 *  Wages on the revenue rule. Both can be true: fetchAllocationPool merges QB POSTED
 *  transactions with local drafts, and the earlier probe only saw the second half.
 *
 *  This splits every CS-account pool line by txnType + docNumber so the source is unambiguous.
 *
 *  No writes. Untracked scratch.
 */
import '../lib/load-env';
import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';

const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CS_RE = /customer service/i;

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '2026-03';
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(arg);
  if (!match) { console.error('usage: npx tsx scripts/payroll/probe-cs-pool-source.ts YYYY-MM'); process.exit(1); }
  const m = { year: Number(match[1]), month: Number(match[2]) };

  const { pool, attention } = await fetchAllocationPool(m);

  const cs = pool.filter((l) => CS_RE.test(l.accountName));
  console.log(`\n=== ${arg}: ${pool.length} pool lines, ${cs.length} on a Customer Service account ===`);

  const byType = new Map<string, { n: number; total: number }>();
  for (const l of cs) {
    const k = `${l.entity} | ${l.txnType} | ${l.rule} | ${l.className ?? `dept:${l.departmentName}`}`;
    const cur = byType.get(k) ?? { n: 0, total: 0 };
    cur.n++; cur.total += l.amount;
    byType.set(k, cur);
  }
  console.log(`\n-- CS lines by entity / txnType / rule / tag --`);
  for (const [k, v] of [...byType].sort()) console.log(`  ${k.padEnd(72)} ${String(v.n).padStart(4)} ln  ${money(v.total).padStart(14)}`);

  console.log(`\n-- individual CS pool lines --`);
  for (const l of cs.sort((a, b) => a.entity.localeCompare(b.entity) || a.txnDate.localeCompare(b.txnDate))) {
    console.log(
      `  ${l.txnDate} ${l.entity.padEnd(12)} ${l.txnType.padEnd(12)} ${(l.docNumber ?? '-').padEnd(24)} ` +
      `${money(l.amount).padStart(13)}  ${l.accountName}  | ${l.memo ?? ''}`,
    );
  }

  // Whole-pool shape, so the CS share is readable in context.
  const poolByType = new Map<string, { n: number; total: number }>();
  for (const l of pool) {
    const cur = poolByType.get(l.txnType) ?? { n: 0, total: 0 };
    cur.n++; cur.total += l.amount;
    poolByType.set(l.txnType, cur);
  }
  console.log(`\n-- whole pool by txnType --`);
  for (const [k, v] of [...poolByType].sort()) console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)} ln  ${money(v.total).padStart(14)}`);
  console.log(`  attention (not allocated): ${attention.length} lines`);

  process.exit(0);
}

void main();
