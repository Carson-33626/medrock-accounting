export type Entity = 'FL' | 'TN' | 'TX';
export type QBLocation = 'MedRock FL' | 'MedRock TN' | 'MedRock TX';

export const ENTITY_TO_QB_LOCATION: Record<Entity, QBLocation> = {
  FL: 'MedRock FL',
  TN: 'MedRock TN',
  TX: 'MedRock TX',
};

export const ALL_ENTITIES: readonly Entity[] = ['FL', 'TN', 'TX'];

// ---- QuickBooks (source of truth) ----
export interface QBLine {
  description: string | null;
  amountCents: number;
  glAccountId: string;        // QB Account.Id (AccountRef.value)
  glAccountName: string | null;
  classId: string | null;     // QB Class.Id, if coded
  locationId: string | null;  // QB Department/Location.Id, if coded
}

export interface QBEntry {
  realm: Entity;              // which QB company the itemization lives in
  qbEntryId: string;          // Purchase/Bill Id
  docType: 'Purchase' | 'Bill';
  orderNo: string | null;     // DocNumber (Amazon order#)
  txnDate: string;            // 'YYYY-MM-DD'
  totalCents: number;
  vendor: string | null;
  lines: QBLine[];
}

// ---- Ramp (write target; read-only in Phase 0) ----
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
}

// ---- coding lookups: qb id -> ramp field_option_external_id (option.id) ----
export interface CodingMap {
  gl: Record<string, string>;
  klass: Record<string, string>;   // 'class' is reserved-ish; use klass
  location: Record<string, string>;
}

// ---- matching ----
export type MatchTier = 'order_no' | 'amount_date';

export interface Match {
  qb: QBEntry;
  ramp: RampTxn;
  tier: MatchTier;
}

export interface AmbiguousMatch {
  qb: QBEntry;
  candidates: RampTxn[];
  reason: string;
}

export interface MatchResult {
  confident: Match[];
  ambiguous: AmbiguousMatch[];
  unmatched: QBEntry[];
}

export type Drift = 'same_entity' | 'cross_entity';

// ---- Ramp write payloads (BUILT in Phase 0, never sent) ----
export interface AccountingFieldSelection {
  field_external_id: string;
  field_option_external_id: string;
}
export interface PatchLineItem {
  amount: number;             // minor units
  memo: string | null;
  accounting_field_selections: AccountingFieldSelection[];
}
export interface PatchPayload {
  line_items: PatchLineItem[];
}
export interface MemoPayload {
  memo: string;
}

// ---- audit ----
export interface AuditEvent {
  runId: string;
  phase: 'preview' | 'gate_test' | 'pilot' | 'production';
  mode: 'dry_run' | 'live';
  eventType: 'match' | 'write_split' | 'write_memo' | 'flag' | 'skip' | 'error';
  outcome: 'success' | 'failed' | 'flagged_for_review' | 'skipped' | 'dry_run';
  entity: Entity | null;
  rampTransactionId: string | null;
  qbRealm: Entity | null;
  qbDocNumber: string | null;
  qbEntryId: string | null;
  matchTier: MatchTier | null;
  drift: Drift | null;
  amountCents: number | null;
  priorState: unknown | null;
  requestPayload: unknown | null;
  responseStatus: number | null;
  responseBody: unknown | null;
  reason: string | null;
}
