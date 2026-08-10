// Entity/Location for web/-side Ramp scripts.
//
// Location is imported, never redeclared: it and Entity must stay identical (see the FOCAS work),
// and that correspondence is compiler-asserted against src/lib. A third copy would be a third
// thing to keep in sync. The receipt-enrichment program owns the only other copy.
//
// NOTE: the program's Entity (scripts/receipt-enrichment/engines/ramp-split-push/types.ts) is
// currently 'FL' | 'TN' | 'TX' only — FOCS/FOCAS isn't a member there yet (FOCAS Ramp drafts
// aren't postable until probe->seed->regen). This file mirrors that file's actual values, which
// differ from the 4-entity example in the task brief.
import type { Location } from '../../src/lib/quickbooks-multi';

export type Entity = 'FL' | 'TN' | 'TX';

export const ALL_ENTITIES: readonly Entity[] = ['FL', 'TN', 'TX'];

export const ENTITY_TO_QB_LOCATION: Readonly<Record<Entity, Location>> = {
  FL: 'MedRock FL',
  TN: 'MedRock TN',
  TX: 'MedRock TX',
};

// Needed by ramp.ts (getRampTransactions' return type). None of the 29 consumers import this
// directly, but ramp-client.ts's own import of it from './types' has to resolve to something here.
export interface RampTxn {
  id: string;
  entity: Entity;             // the card's home entity (which credential saw it)
  amountCents: number;
  date: string;               // 'YYYY-MM-DD' (user_transaction_time)
  cardId: string | null;
  cardHolder: string | null;
  cardLast4?: string | null;  // card_last_four when available; matching tiebreaker only
  userId: string | null;      // card_holder.user_id — required to upload a receipt (POST /receipts)
  memo: string | null;
  merchantName: string | null;
  orderNo: string | null;     // parsed from memo/descriptor/line_items, else null
  priorLineItems: unknown;    // raw line_items snapshot for audit prior_state (opaque passthrough)
  // Write-eligibility, populated by getRampTransactions. Optional because older constructors predate
  // them; absent MUST read as "unknown", and callers gate writes conservatively on the known-good value
  // (a PATCH against a SYNCED txn is what produced 12 HTTP 403s on 2026-07-30).
  state?: string | null;        // 'CLEARED' | 'PENDING' | ...
  syncStatus?: string | null;   // 'NOT_SYNC_READY' | 'SYNCED' | ...
  receiptCount?: number;        // receipts already on the txn — attaching a second is irreversible
}
