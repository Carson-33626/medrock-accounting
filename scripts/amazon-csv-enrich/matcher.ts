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
  const confident: ChargeMatch[] = [];
  const ambiguous: AmazonCharge[] = [];
  const unmatched: AmazonCharge[] = [];
  const used = new Set<string>();

  for (const charge of charges) {
    let cands = txns.filter((t) =>
      !used.has(t.id) &&
      t.amountCents === charge.chargeCents &&
      charge.payDate !== '' && t.date !== '' &&
      daysBetween(t.date, charge.payDate) <= windowDays);
    if (cands.length > 1 && charge.cardLast4) {
      const narrowed = cands.filter((t) => t.cardLast4 && t.cardLast4 === charge.cardLast4);
      if (narrowed.length >= 1) cands = narrowed;
    }
    if (cands.length === 1) { confident.push({ charge, txn: cands[0] }); used.add(cands[0].id); }
    else if (cands.length > 1) ambiguous.push(charge);
    else unmatched.push(charge);
  }
  return { confident, ambiguous, unmatched };
}
