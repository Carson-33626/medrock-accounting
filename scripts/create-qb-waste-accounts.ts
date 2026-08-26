// Create `5000.55 Cost of Goods Sold:Drug Waste & Shrinkage` in each connected
// QB company — the dedicated line the inventory close's waste/shrink JEs post to
// (close-package-method-note.md sec 2.4; verified missing in all three by
// probe-qb-waste-accounts.ts). Carson-authorized write, 2026-08-26.
// Idempotent: skips a company that already has AcctNum 5000.55 or a
// waste/shrink-named COGS account. Parent = the existing `5000` COGS header;
// AccountSubType copied from sibling 5000.10 (Compound Ingredient) so the new
// account matches the chart's existing pattern.
// Run from web/:  npx tsx scripts/create-qb-waste-accounts.ts
import './lib/load-env';
import { qbQueryAll, qbPost, getConnectedLocations } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface QbAccount {
  Id?: string;
  Name?: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  AcctNum?: string;
  Active?: boolean;
}

interface QbAccountCreateResponse {
  Account?: QbAccount;
}

const NEW_ACCT_NUM = '5000.55';
const NEW_NAME = 'Drug Waste & Shrinkage';
// QBO caps Account.Description at 100 chars (error 2050 above that).
const DESCRIPTION = 'Drug disposal (lot adjustments) + count-residual shrink from monthly inventory close.';

async function main(): Promise<void> {
  const locations: Location[] = await getConnectedLocations();
  for (const location of locations) {
    if (location === 'FOCAS') {
      console.log('FOCAS: no inventory operations — skipping by design');
      continue;
    }
    const accts = await qbQueryAll<QbAccount>(location, 'Account', '');

    // TN's legacy `6999.33 Inventory Shrinkage (DO NOT USE)` must not satisfy
    // this check — it is the account the method note explicitly refuses to revive.
    const existing = accts.find(
      (a) =>
        a.AcctNum === NEW_ACCT_NUM ||
        (a.AccountType === 'Cost of Goods Sold' &&
          /waste|shrink/i.test(a.Name ?? '') &&
          !/do not use/i.test(a.Name ?? '')),
    );
    if (existing) {
      console.log(
        `${location}: already has ${existing.AcctNum ?? '(no num)'} ` +
          `${existing.FullyQualifiedName ?? existing.Name ?? ''} — skipping`,
      );
      continue;
    }

    const parent = accts.find(
      (a) => a.AcctNum === '5000' && a.AccountType === 'Cost of Goods Sold' && a.Active !== false,
    );
    if (!parent?.Id) {
      console.error(`${location}: no active 5000 COGS header found — NOT creating; resolve manually`);
      continue;
    }

    const sibling =
      accts.find((a) => a.AcctNum === '5000.10') ?? accts.find((a) => a.AcctNum === '5000.05');
    const subType = sibling?.AccountSubType ?? 'SuppliesMaterialsCogs';

    const body = {
      Name: NEW_NAME,
      AcctNum: NEW_ACCT_NUM,
      AccountType: 'Cost of Goods Sold',
      AccountSubType: subType,
      SubAccount: true,
      ParentRef: { value: parent.Id },
      Description: DESCRIPTION,
    };
    console.log(
      `${location}: creating ${NEW_ACCT_NUM} ${NEW_NAME} under ${parent.FullyQualifiedName ?? '5000'} ` +
        `(subtype ${subType} from sibling ${sibling?.AcctNum ?? 'default'})...`,
    );
    const created = await qbPost<QbAccountCreateResponse>(location, 'account?minorversion=75', body);
    const acct = created.Account;
    console.log(
      `${location}: CREATED Id=${acct?.Id ?? '?'} ${acct?.AcctNum ?? ''} ` +
        `${acct?.FullyQualifiedName ?? acct?.Name ?? ''}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
