// Inverted match: each Amazon charge (from the CSV) -> a pooled un-enriched Ramp Amazon txn, by exact
// amount + date window, disambiguated by card last-4 when a same-amount collision occurs. The matched
// txn's entity is authoritative for GL resolution (Account Group is unreliable and never used here).
import type { AmazonCharge, ChargeMatch, MatchResult } from './types';
import type { RampTxn } from '../ramp-split-push/types';

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime());
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : Number.POSITIVE_INFINITY;
}

export function matchCharges(charges: AmazonCharge[], txns: RampTxn[], windowDays = 3): MatchResult {
  // Pass 1: each charge's candidate txns (exact amount + date window; last-4 narrows a same-amount collision).
  const candOf = new Map<AmazonCharge, RampTxn[]>();
  for (const charge of charges) {
    let cands = txns.filter((t) =>
      t.amountCents === charge.chargeCents &&
      charge.payDate !== '' && t.date !== '' &&
      daysBetween(t.date, charge.payDate) <= windowDays);
    if (cands.length > 1 && charge.cardLast4) {
      const narrowed = cands.filter((t) => t.cardLast4 && t.cardLast4 === charge.cardLast4);
      if (narrowed.length >= 1) cands = narrowed;
    }
    candOf.set(charge, cands);
  }
  // Pass 2: a txn listed as a candidate by more than one charge is CONTESTED — confidently assigning it
  // to either would risk attaching one purchase's items to the other's transaction. So a charge is
  // confident only when it has exactly one candidate AND that txn is claimed by exactly one charge.
  // This also guarantees the no-reuse invariant (a uniquely-claimed txn goes to a single charge).
  const claimCount = new Map<string, number>();
  for (const cands of candOf.values()) for (const t of cands) claimCount.set(t.id, (claimCount.get(t.id) ?? 0) + 1);

  const confident: ChargeMatch[] = [];
  const ambiguous: AmazonCharge[] = [];
  const unmatched: AmazonCharge[] = [];
  for (const [charge, cands] of candOf) {
    if (cands.length === 0) unmatched.push(charge);
    else if (cands.length > 1) ambiguous.push(charge);
    else if ((claimCount.get(cands[0].id) ?? 0) === 1) confident.push({ charge, txn: cands[0] });
    else ambiguous.push(charge);
  }
  return { confident, ambiguous, unmatched };
}
