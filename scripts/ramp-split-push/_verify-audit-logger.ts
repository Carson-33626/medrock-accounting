import './load-env';
import { randomUUID } from 'node:crypto';
import { logAuditEvents } from './audit-logger';
import { getRdsPool } from '../../src/lib/rds';
import type { AuditEvent } from './types';

async function main(): Promise<void> {
  const runId = randomUUID();
  const ev: AuditEvent = {
    runId, phase: 'preview', mode: 'dry_run', eventType: 'match', outcome: 'dry_run',
    entity: 'FL', rampTransactionId: 'TEST', qbRealm: 'FL', qbDocNumber: '111-2222222-3333333',
    qbEntryId: 'q1', matchTier: 'order_no', drift: 'same_entity', amountCents: 1999,
    priorState: { line_items: [] }, requestPayload: { line_items: [{ amount: 1999 }] },
    responseStatus: null, responseBody: null, reason: 'verification harness',
  };
  const n = await logAuditEvents([ev]);
  const pool = getRdsPool();
  const r = await pool.query('select count(*) from accounting.ramp_split_push_audit where run_id = $1', [runId]);
  console.log('inserted:', n, 'read back:', r.rows[0].count);
  await pool.end();
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
