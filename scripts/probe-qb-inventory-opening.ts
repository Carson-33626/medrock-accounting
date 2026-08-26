// READ-ONLY probe: QB inventory-asset book balances as of 2026-02-28 (the
// settled stop point's eve) and today, per company — sizes the one-time
// correction JE that trues book inventory to the FIFO opening before the
// 2026-03+ method JEs post (Carson's ruling 2026-08-26).
// Run from web/:  npx tsx scripts/probe-qb-inventory-opening.ts
import './lib/load-env';
import { getBalanceSheetInventory, getConnectedLocations } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

const STOP_EVE = '2026-02-28';
const TODAY = '2026-08-26';

async function main(): Promise<void> {
  const locations: Location[] = await getConnectedLocations();
  for (const location of locations) {
    if (location === 'FOCAS') continue;
    for (const asOf of [STOP_EVE, TODAY]) {
      const bs = await getBalanceSheetInventory(location, asOf);
      if (!bs) {
        console.log(`${location} @ ${asOf}: balance sheet unavailable`);
        continue;
      }
      console.log(`\n=== ${location} @ ${asOf} — ${bs.accountName} total $${bs.total.toLocaleString()}`);
      for (const a of bs.accounts) {
        console.log(`  ${a.name.padEnd(55)} $${a.value.toLocaleString()}`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
