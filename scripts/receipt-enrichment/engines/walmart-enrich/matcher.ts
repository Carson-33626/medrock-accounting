// Join Walmart orders to Ramp Walmart-card charges. Exact total + date window; unique-or-ambiguous.
// (Per-shipment multi-charge orders are surfaced by the orchestrator when a single charge doesn't
// equal the order total; here we do the clean 1:1 exact-amount match and defer non-unique to review.)
import type { RampTxn } from '../ramp-split-push/types';

export interface WalmartOrder { orderId: string; date: string; totalCents: number }
export interface OrderMatch { order: WalmartOrder; txn: RampTxn }
export interface MatchResult { confident: OrderMatch[]; ambiguous: WalmartOrder[]; unmatched: WalmartOrder[] }

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime());
  return Math.round(ms / 86400000);
}

export function matchOrders(orders: WalmartOrder[], txns: RampTxn[], windowDays = 3): MatchResult {
  const confident: OrderMatch[] = [];
  const ambiguous: WalmartOrder[] = [];
  const unmatched: WalmartOrder[] = [];
  const used = new Set<string>();

  for (const order of orders) {
    // Candidates BEFORE the claim filter: an order whose same-amount candidates span two entities can
    // never be resolved safely, because a claim by an earlier order could collapse the set to a single
    // survivor in the WRONG company and that survivor would score "confident". The amounts still tie out,
    // so nothing downstream would flag it — one purchase's itemization and receipt would simply land on
    // another entity's books. Refuse rather than guess. (The pool became multi-entity on 2026-07-30; a
    // single-entity pool is unaffected, since every candidate then shares one entity by construction.)
    const allCands = txns.filter((t) =>
      t.amountCents === order.totalCents &&
      daysBetween(t.date, order.date) <= windowDays);
    if (new Set(allCands.map((t) => t.entity)).size > 1) {
      ambiguous.push(order);
      continue;
    }

    const cands = allCands.filter((t) => !used.has(t.id));
    if (cands.length === 1) {
      confident.push({ order, txn: cands[0] });
      used.add(cands[0].id);
    } else if (cands.length > 1) {
      ambiguous.push(order);
    } else {
      unmatched.push(order);
    }
  }
  return { confident, ambiguous, unmatched };
}
