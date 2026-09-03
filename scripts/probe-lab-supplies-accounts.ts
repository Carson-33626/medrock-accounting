// READ-ONLY probe: which accounts does the lab-supplies accrual actually have to work with?
//
// The display currently claims the entry posts "Dr 5000.25 Lab Supplies / Cr 1220.20 Lab
// Supplies Inventory". Crediting an ASSET is right for RELIEVING stranded inventory (the FIFO
// close draft already does that), but wrong for an ACCRUAL of purchases not yet entered — there
// is no asset left to relieve once the close has written 1220.20 to zero, so repeating it every
// month drives the asset negative. An accrual credits a LIABILITY.
//
// This lists, per realm: the 1220.20 / 5000.25 pair and their balances, plus every liability
// account that could be the credit side.
//
// Run from web/:  npx tsx scripts/probe-lab-supplies-accounts.ts
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
}

const money = (n: number | undefined): string => (n ?? 0).toFixed(2).padStart(13);

function show(a: QbAccount): string {
  return [
    (a.AcctNum ?? '—').padEnd(9),
    (a.FullyQualifiedName ?? a.Name ?? '').slice(0, 46).padEnd(46),
    (a.AccountType ?? '').slice(0, 20).padEnd(20),
    (a.AccountSubType ?? '').slice(0, 24).padEnd(24),
    money(a.CurrentBalance),
    a.Active === false ? ' INACTIVE' : '',
  ].join('  ');
}

async function main(): Promise<void> {
  const locations: Location[] = await getConnectedLocations();

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);

    const all = await qbQueryAll<QbAccount>(location, 'Account', '');

    const pair = all.filter((a) => a.AcctNum === '1220.20' || a.AcctNum === '5000.25');
    console.log('\n-- the lab-supplies pair --');
    for (const a of pair) console.log(show(a));
    if (pair.length === 0) console.log('  (neither account exists in this realm)');

    console.log('\n-- liability accounts (candidate credit side) --');
    const liabilities = all.filter(
      (a) =>
        a.AccountType === 'Other Current Liability' ||
        a.AccountType === 'Accounts Payable' ||
        a.AccountType === 'Long Term Liability',
    );
    for (const a of liabilities.sort((x, y) => (x.AcctNum ?? '').localeCompare(y.AcctNum ?? ''))) {
      console.log(show(a));
    }

    console.log('\n-- anything named like an accrual --');
    for (const a of all) {
      const name = `${a.FullyQualifiedName ?? a.Name ?? ''}`;
      if (/accru|accrued/i.test(name)) console.log(show(a));
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
