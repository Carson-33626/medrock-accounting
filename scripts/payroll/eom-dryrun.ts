// scripts/payroll/eom-dryrun.ts
// Month-end allocation DRY-RUN: pulls the real pool + revenue test for a month and
// prints the drafts that WOULD be generated. Read-only — no DB writes, no QB writes.
import '../receipt-enrichment/engines/ramp-split-push/load-env';
import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';
import { fetchRevenuePresence, sharesFromPresence, EOM_ENTITIES, type EomEntity } from '../../src/lib/payroll/revenue-rule';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(arg ?? '');
  if (!match) { console.error('usage: npx tsx scripts/payroll/eom-dryrun.ts YYYY-MM'); process.exit(1); }
  const m = { year: Number(match[1]), month: Number(match[2]) };

  const revenue = await fetchRevenuePresence(m);
  const shares = sharesFromPresence(revenue) ?? ({ 'MedRock FL': 0, 'MedRock TN': 0, 'MedRock TX': 0 } as Record<EomEntity, number>);
  console.log(`\n=== Revenue test ${revenue.month} (Accrual) ===`);
  for (const e of EOM_ENTITIES) console.log(`  ${e}: income $${revenue.income[e].toFixed(2)} -> share ${shares[e].toFixed(2)}%`);

  const { pool, attention } = await fetchAllocationPool(m);
  console.log(`\n=== Pool: ${pool.length} lines ===`);
  const byKey = new Map<string, number>();
  for (const l of pool) {
    const k = `${l.entity} | ${l.rule} | ${l.accountName}`;
    byKey.set(k, (byKey.get(k) ?? 0) + l.amount);
  }
  for (const [k, v] of [...byKey].sort()) console.log(`  ${k}  $${v.toFixed(2)}`);
  console.log(`\n=== Attention (${attention.length} lines: passthrough/unknown, NOT allocated) ===`);
  for (const l of attention) console.log(`  ${l.entity} ${l.rule} ${l.txnType} ${l.docNumber ?? l.txnId} "${l.className ?? l.departmentName}" ${l.accountName} $${l.amount.toFixed(2)} ${l.memo ?? ''}`);

  const drafts = buildMonthEndAllocation(pool, shares, m);
  for (const d of drafts) {
    console.log(`\n=== DRAFT ${d.docNumber} (${d.entity}) TxnDate ${d.txnDate} — Dr $${d.totalDebits.toFixed(2)} / Cr $${d.totalCredits.toFixed(2)} / var ${d.variance} ===`);
    for (const l of d.lines) console.log(`  ${l.postingType.padEnd(6)} $${l.amount.toFixed(2).padStart(12)}  ${l.accountName}  | ${l.memo}`);
  }
  process.exit(0);
}
void main();
