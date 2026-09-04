// READ-ONLY probe: what are the QB "Credit card (100x)" funding accounts, and what is still
// being charged to them in the last 90 days? They are NOT the Ramp connection (zero overlap on
// vendor+date+amount with Ramp-funded Purchases), so anything living there is spend the Ramp
// sweep cannot see.
// Run from web/:  npx tsx scripts/probe-qb-card-accounts.ts
import './lib/load-env';
import { qbQueryAll, getConnectedLocations } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface QbAccount {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  AcctNum?: string;
  Active?: boolean;
  CurrentBalance?: number;
  Description?: string;
}

async function main(): Promise<void> {
  const locations: Location[] = await getConnectedLocations();
  for (const location of locations) {
    const accts = await qbQueryAll<QbAccount>(
      location,
      'Account',
      "WHERE AccountType IN ('Credit Card','Bank')",
    );
    if (accts.length === 0) continue;
    console.log(`\n=== ${location} ===`);
    for (const a of accts) {
      console.log(
        `  ${(a.AcctNum ?? '').padEnd(10)}${(a.Name ?? '').padEnd(34)}${(a.AccountType ?? '').padEnd(14)}` +
          `${(a.AccountSubType ?? '').padEnd(20)}active=${a.Active === false ? 'NO ' : 'yes'}  bal=${(a.CurrentBalance ?? 0).toFixed(2)}` +
          (a.Description ? `  // ${a.Description.slice(0, 60)}` : ''),
      );
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
