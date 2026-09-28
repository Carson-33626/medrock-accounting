// READ-ONLY: which hand-keyed QuickBooks allocation adjustments does the difference check net?
import './load-env-vercel-first';
import { listManualEomAdjustments } from '../../src/lib/payroll/eom-manual';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-04';
  const m = { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
  for (const entity of EOM_ENTITIES) {
    const adj = await listManualEomAdjustments(m, entity);
    console.log(`${entity}: ${adj.length} hand-keyed ${month} allocation adjustment(s)`);
    for (const a of adj) {
      console.log(`  QB ${a.qbEntryId} "${a.docNumber}"`);
      for (const l of a.lines) console.log(`    ${l.postingType.padEnd(6)} ${l.amount.toFixed(2).padStart(11)}  ${l.accountName}`);
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
