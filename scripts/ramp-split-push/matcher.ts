import type { QBEntry, RampTxn, MatchResult } from './types';

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a + 'T00:00:00Z');
  const db = Date.parse(b + 'T00:00:00Z');
  return Math.abs(da - db) / 86_400_000;
}

export function matchEntries(qb: QBEntry[], ramp: RampTxn[], dateWindowDays: number): MatchResult {
  const result: MatchResult = { confident: [], ambiguous: [], unmatched: [] };
  const usedRamp = new Set<string>();

  // Tier ①: order number.
  const byOrder = new Map<string, RampTxn[]>();
  for (const t of ramp) {
    if (!t.orderNo) continue;
    const arr = byOrder.get(t.orderNo) ?? [];
    arr.push(t);
    byOrder.set(t.orderNo, arr);
  }

  const remaining: QBEntry[] = [];
  for (const e of qb) {
    if (e.orderNo) {
      const cands = (byOrder.get(e.orderNo) ?? []).filter((t) => !usedRamp.has(t.id));
      if (cands.length === 1) {
        usedRamp.add(cands[0].id);
        result.confident.push({ qb: e, ramp: cands[0], tier: 'order_no' });
        continue;
      }
      if (cands.length > 1) {
        result.ambiguous.push({ qb: e, candidates: cands, reason: 'multiple ramp txns share this order#' });
        continue;
      }
    }
    remaining.push(e);
  }

  // Tier ②: exact amount + date window + card.
  for (const e of remaining) {
    const cands = ramp.filter(
      (t) =>
        !usedRamp.has(t.id) &&
        t.amountCents === e.totalCents &&
        daysBetween(e.txnDate, t.date) <= dateWindowDays,
    );
    const cardMatch = cands.filter((t) => t.cardId !== null);
    const pick = cardMatch.length > 0 ? cardMatch : cands;
    if (pick.length === 1) {
      usedRamp.add(pick[0].id);
      result.confident.push({ qb: e, ramp: pick[0], tier: 'amount_date' });
    } else if (pick.length > 1) {
      result.ambiguous.push({ qb: e, candidates: pick, reason: 'multiple amount+date candidates' });
    } else {
      result.unmatched.push(e);
    }
  }

  return result;
}
