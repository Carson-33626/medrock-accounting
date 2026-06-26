import './load-env';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ALL_ENTITIES } from './types';
import type { AuditEvent, Entity, Match } from './types';
import { rampToken, getRampTransactions } from './ramp-client';
import { buildCodingMap } from './coding-map';
import { readAllQbAmazonEntries } from './qb-amazon-reader';
import { matchEntries } from './matcher';
import { classifyDrift } from './drift-classifier';
import { buildPatchPayload, buildMemo } from './payload-builder';
import { logAuditEvents } from './audit-logger';
import { getRdsPool } from '../../src/lib/rds';

const DATE_WINDOW_DAYS = 3;
const OUT_DIR = 'scripts/ramp-split-push/out';

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

function flagEvent(runId: string, entity: Entity, m: Match, drift: 'same_entity' | 'cross_entity', reason: string): AuditEvent {
  return {
    runId, phase: 'preview', mode: 'dry_run', eventType: 'flag', outcome: 'flagged_for_review',
    entity, rampTransactionId: m.ramp.id, qbRealm: m.qb.realm, qbDocNumber: m.qb.orderNo,
    qbEntryId: m.qb.qbEntryId, matchTier: m.tier, drift, amountCents: m.qb.totalCents,
    priorState: m.ramp.priorLineItems, requestPayload: null, responseStatus: null, responseBody: null, reason,
  };
}

async function main(): Promise<void> {
  const runId = randomUUID();
  console.log('run_id:', runId);
  mkdirSync(OUT_DIR, { recursive: true });

  const qbAll = await readAllQbAmazonEntries();
  console.log('QB Amazon entries (all realms):', qbAll.length);

  const events: AuditEvent[] = [];
  const previewRows: (string | number | null)[][] = [];
  const reviewRows: (string | number | null)[][] = [];

  for (const entity of ALL_ENTITIES) {
    const token = await rampToken(entity, 'transactions:read accounting:read');
    const ramp = await getRampTransactions(entity, token);
    const coding = await buildCodingMap(entity, token);
    const result = matchEntries(qbAll, ramp, DATE_WINDOW_DAYS);

    for (const m of result.confident) {
      const drift = classifyDrift(m);
      if (drift === 'cross_entity') {
        events.push(flagEvent(runId, entity, m, 'cross_entity', 'cross-legal-entity: card entity != QB realm'));
        reviewRows.push([entity, m.ramp.id, m.qb.realm, m.qb.orderNo, m.qb.totalCents, 'cross_entity']);
        continue;
      }
      const { payload, flags } = buildPatchPayload(m.qb, coding);
      const memo = buildMemo(m.qb);
      if (flags.length > 0) {
        events.push(flagEvent(runId, entity, m, 'same_entity', flags.join('; ')));
        reviewRows.push([entity, m.ramp.id, m.qb.realm, m.qb.orderNo, m.qb.totalCents, flags.join('; ')]);
        continue;
      }
      events.push({
        runId, phase: 'preview', mode: 'dry_run', eventType: 'match', outcome: 'dry_run',
        entity, rampTransactionId: m.ramp.id, qbRealm: m.qb.realm, qbDocNumber: m.qb.orderNo,
        qbEntryId: m.qb.qbEntryId, matchTier: m.tier, drift: 'same_entity', amountCents: m.qb.totalCents,
        priorState: m.ramp.priorLineItems, requestPayload: { patch: payload, memo },
        responseStatus: null, responseBody: null, reason: null,
      });
      previewRows.push([entity, m.ramp.id, m.qb.orderNo, m.qb.totalCents, m.tier, payload.line_items.length, memo.memo]);
    }

    for (const a of result.ambiguous) {
      events.push({
        runId, phase: 'preview', mode: 'dry_run', eventType: 'flag', outcome: 'flagged_for_review',
        entity, rampTransactionId: null, qbRealm: a.qb.realm, qbDocNumber: a.qb.orderNo,
        qbEntryId: a.qb.qbEntryId, matchTier: null, drift: null, amountCents: a.qb.totalCents,
        priorState: null, requestPayload: null, responseStatus: null, responseBody: null, reason: a.reason,
      });
      reviewRows.push([entity, '', a.qb.realm, a.qb.orderNo, a.qb.totalCents, a.reason]);
    }
    console.log(`${entity}: confident ${result.confident.length}, ambiguous ${result.ambiguous.length}, unmatched ${result.unmatched.length}`);
  }

  const inserted = await logAuditEvents(events);
  writeFileSync(`${OUT_DIR}/preview_writes.csv`, toCsv(['entity', 'ramp_txn', 'order_no', 'amount_cents', 'tier', 'line_count', 'memo'], previewRows));
  writeFileSync(`${OUT_DIR}/review_queue.csv`, toCsv(['entity', 'ramp_txn', 'qb_realm', 'order_no', 'amount_cents', 'reason'], reviewRows));
  console.log(`audit rows inserted: ${inserted}`);
  console.log(`CSV: ${OUT_DIR}/preview_writes.csv (${previewRows.length}), ${OUT_DIR}/review_queue.csv (${reviewRows.length})`);

  await getRdsPool().end();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
