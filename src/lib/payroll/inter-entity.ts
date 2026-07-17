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
