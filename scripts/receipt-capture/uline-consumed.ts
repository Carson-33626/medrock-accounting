// scripts/receipt-capture/uline-consumed.ts
//
// Consumed-invoice registry for ULINE. FL and TN are a JOINT account (Carson confirmed
// 2026-07-29): different logins, one shared invoice roster. Independent per-entity matching
// against that shared roster can double-claim an invoice whenever a total collides across
// entities, so every invoice that has ever had a receipt attached gets recorded here,
// keyed by invoice number, and consulted (in BOTH joint and solo run modes) before planning
// any live action on a matched invoice — a hit means "already handled elsewhere," skip it.
//
// Same load/write-through shape as walmart-enrich/extraction-store.ts: an in-memory Map backed
// by a JSON file rewritten in full on every record() (append-only in effect — entries are never
// removed by this module), so a mid-run crash loses nothing already recorded.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entity } from '../ramp-split-push/types';

export interface ConsumedRecord {
  txnId: string;
  entity: Entity;
  ts: string;
}

export type ConsumedRegistry = Record<string, ConsumedRecord>; // invoiceNumber -> record

export interface ConsumedStore {
  has(invoiceNumber: string): boolean;
  record(invoiceNumber: string, txnId: string, entity: Entity): void;
  all(): ConsumedRegistry;
  // True when a registry file existed at load time but failed to parse — the store still starts
  // empty (see below) but the caller needs to know this happened, since "empty" is otherwise
  // indistinguishable from a brand-new registry and a --live run must not silently risk a
  // double-claim on top of a corrupt file it can no longer read.
  corrupt: boolean;
}

export function loadConsumedStore(path: string): ConsumedStore {
  const map = new Map<string, ConsumedRecord>();
  let corrupt = false;
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as ConsumedRegistry;
      for (const [invoiceNumber, rec] of Object.entries(data)) map.set(invoiceNumber, rec);
    } catch (e) {
      corrupt = true;
      console.warn(`[uline-consumed] corrupt registry at ${path} — starting empty: ${(e as Error).message}`);
    }
  }
  // Atomic flush: write to a sibling .tmp file then rename over the real path. A rename is a
  // single filesystem operation (no partial-write window), so a crash mid-flush leaves either the
  // old file intact or the new one fully written — never a half-written JSON file that would trip
  // the corrupt path above on the next load.
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(map), null, 2));
    renameSync(tmpPath, path);
  };
  return {
    has: (invoiceNumber) => map.has(invoiceNumber),
    record: (invoiceNumber, txnId, entity) => {
      map.set(invoiceNumber, { txnId, entity, ts: new Date().toISOString() });
      flush();
    },
    all: () => Object.fromEntries(map),
    corrupt,
  };
}
