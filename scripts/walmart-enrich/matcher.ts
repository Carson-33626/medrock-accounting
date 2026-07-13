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
    const cands = txns.filter((t) =>
      !used.has(t.id) &&
      t.amountCents === order.totalCents &&
      daysBetween(t.date, order.date) <= windowDays);
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
