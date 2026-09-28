// READ-ONLY: why does the EOM revenue split differ from Barbara's "by rev" figures?
// Prints per-entity P&L income and the classed (passthrough) revenue riding deposits.
// Usage: npx tsx scripts/payroll/_probe-eom-revenue-basis.ts 2026-05
import './load-env-vercel-first';
import { fetchRevenuePresence, sharesFromRevenue, EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import { fetchAllocationPool } from '../../src/lib/payroll/qb-pool';

async function main(): Promise<void> {
  const [y, mo] = (process.argv[2] ?? '2026-05').split('-').map(Number);
  const m = { year: y, month: mo };
  const rt = await fetchRevenuePresence(m);
  const sh = sharesFromRevenue(rt);
  for (const e of EOM_ENTITIES) console.log(`${e}: P&L income ${rt.income[e].toFixed(2)}  share ${sh?.[e].toFixed(2)}%`);
  const { pool } = await fetchAllocationPool(m);
  const dep = pool.filter((l) => l.txnType === 'Deposit');
  const byKey = new Map<string, number>();
  for (const l of dep) {
    const k = `${l.entity} -> ${l.counterparty ?? l.rule} [${l.accountName}]`;
    byKey.set(k, (byKey.get(k) ?? 0) + l.amount);
  }
  for (const [k, v] of byKey) console.log(`  deposit ${k}: ${v.toFixed(2)}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
