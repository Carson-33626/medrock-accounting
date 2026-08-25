// READ-ONLY probe: does each QB company already have an account fit for the
// inventory close's dedicated drug-waste/shrink line? (close-package-method-note.md
// flags this as required setup before the first post — this probe fills its TBD.)
// Prints: (1) any account whose name suggests waste/shrink/disposal/obsolescence,
// (2) every COGS-type account for context, since the waste line must be a sibling
// of (not folded into) usage-driven COGS.
// Run from web/:  npx tsx scripts/probe-qb-waste-accounts.ts
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
  Description?: string;
}

const WASTE_PATTERN = /waste|shrink|spoil|disposal|obsole|scrap|damag|write.?off|expired/i;

function line(a: QbAccount): string {
  return (
    `  ${(a.AcctNum ?? '').padEnd(10)}${(a.FullyQualifiedName ?? a.Name ?? '').padEnd(52)}` +
    `${(a.AccountType ?? '').padEnd(24)}${(a.AccountSubType ?? '').padEnd(26)}` +
    `active=${a.Active === false ? 'NO' : 'yes'}` +
    (a.Description ? `  // ${a.Description.slice(0, 50)}` : '')
  );
}

async function main(): Promise<void> {
  const locations: Location[] = await getConnectedLocations();
  for (const location of locations) {
    const accts = await qbQueryAll<QbAccount>(location, 'Account', '');
    const wasteish = accts.filter((a) =>
      WASTE_PATTERN.test(`${a.Name ?? ''} ${a.FullyQualifiedName ?? ''} ${a.Description ?? ''}`),
    );
    const cogs = accts.filter((a) => a.AccountType === 'Cost of Goods Sold');
    console.log(`\n=== ${location} — ${accts.length} accounts ===`);
    console.log(`-- waste/shrink-named accounts (${wasteish.length}):`);
    for (const a of wasteish) console.log(line(a));
    if (wasteish.length === 0) console.log('  (none — the drug-waste line needs a new account here)');
    console.log(`-- Cost of Goods Sold accounts (${cogs.length}), for placement context:`);
    for (const a of cogs) console.log(line(a));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
