import type { Entity } from './types';

/**
 * The inter-entity ("Due From/To") account each company uses against each other company,
 * reverse-engineered from Amy's live QB (see design spec "The inter-entity account matrix").
 * Each pair is ONE signed account, debited or credited to move the position either way — there
 * is no separate "Due To" in the entity that holds the "Due From". The strings are NOT derivable
 * by rule (TX's FL-counterpart drops the ", LLC" TN carries; "Medrock Pharmacy" == FL), so this
 * is a frozen lookup verified against the COA. `buildJePayload` resolves by exact
 * FullyQualifiedName and throws on a miss, so these must stay literal.
 */
const IE_MATRIX: Readonly<Record<Entity, Readonly<Partial<Record<Entity, string>>>>> = {
  'MedRock FL': { 'MedRock TN': 'Due from MedRock TN, LLC', 'MedRock TX': 'Due From MedRock TX, LLC' },
  'MedRock TN': { 'MedRock FL': 'Due to Medrock Pharmacy, LLC', 'MedRock TX': 'Due From MedRock TX, LLC' },
  'MedRock TX': { 'MedRock FL': 'Due to Medrock Pharmacy', 'MedRock TN': 'Due to Medrock Tennessee' },
};

export function ieAccountFor(holder: Entity, counterparty: Entity): string {
  if (holder === counterparty) {
    throw new Error(`no inter-entity account for a single entity: ${holder}`);
  }
  const acct = IE_MATRIX[holder][counterparty];
  if (!acct) throw new Error(`no inter-entity account: ${holder} -> ${counterparty}`);
  return acct;
}

/** All inter-entity account names across the matrix, built once at module load. */
const IE_ACCOUNT_NAMES: ReadonlySet<string> = new Set(
  Object.values(IE_MATRIX).flatMap((row) => Object.values(row)),
);

/**
 * True if `accountName` is one of the inter-entity ("Due From/To") accounts in IE_MATRIX.
 * Each IE pair deliberately uses a different account name per side (FL's "Due from MedRock
 * TN, LLC" vs TN's "Due to Medrock Pharmacy, LLC"), so IE lines never shed=pickup on a
 * single account name — they only net to zero across all drafts. Callers that flag
 * per-account imbalances should exclude these lines and check the IE net separately.
 */
export function isIeAccount(accountName: string): boolean {
  return IE_ACCOUNT_NAMES.has(accountName);
}
