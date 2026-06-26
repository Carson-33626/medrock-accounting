import type { AuditEvent } from './types';
import { getRdsPool } from '../../src/lib/rds';

const COLS = [
  'run_id', 'phase', 'mode', 'event_type', 'outcome', 'entity', 'ramp_transaction_id',
  'qb_realm', 'qb_doc_number', 'qb_entry_id', 'match_tier', 'drift', 'amount_cents',
  'prior_state', 'request_payload', 'response_status', 'response_body', 'reason',
];

function toRow(e: AuditEvent): unknown[] {
  return [
    e.runId, e.phase, e.mode, e.eventType, e.outcome, e.entity, e.rampTransactionId,
    e.qbRealm, e.qbDocNumber, e.qbEntryId, e.matchTier, e.drift, e.amountCents,
    e.priorState === null ? null : JSON.stringify(e.priorState),
    e.requestPayload === null ? null : JSON.stringify(e.requestPayload),
    e.responseStatus,
    e.responseBody === null ? null : JSON.stringify(e.responseBody),
    e.reason,
  ];
}

export async function logAuditEvents(events: AuditEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const pool = getRdsPool();
  let inserted = 0;
  for (const e of events) {
    const row = toRow(e);
    const placeholders = row.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO accounting.ramp_split_push_audit (${COLS.join(', ')}) VALUES (${placeholders})`,
      row,
    );
    inserted++;
  }
  return inserted;
}
