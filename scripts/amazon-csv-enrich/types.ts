// Shared types for the Amazon CSV receipt-backfill pipeline.
import type { RampTxn } from '../ramp-split-push/types';

export interface AmazonItem {
  desc: string;
  amountCents: number; // Item Net Total (Amazon already allocated tax+shipping into the line)
}

// One card charge = one Payment Reference ID group = one Ramp txn target.
export interface AmazonCharge {
  paymentRef: string;        // Payment Reference ID (group key)
  orderIds: string[];        // order id(s) contributing rows to this charge (usually exactly 1)
  primaryOrderId: string;    // order id used for the invoice fetch + filenames
  accountGroup: string;      // audit/report only — NEVER a matching key (unreliable free text)
  chargeCents: number;       // Payment Amount (the settled charge; NOT Order Net Total)
  payDate: string;           // 'YYYY-MM-DD' from Payment Date
  cardLast4: string | null;  // Payment Identifier (unwrapped); shared across groups, use only as tiebreaker
  items: AmazonItem[];
  itemsTotalCents: number;   // Σ items[].amountCents
}

export interface ChargeMatch { charge: AmazonCharge; txn: RampTxn }
export interface MatchResult {
  confident: ChargeMatch[];
  ambiguous: AmazonCharge[];
  unmatched: AmazonCharge[];
}
