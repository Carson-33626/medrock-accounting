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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
}

export function loadConsumedStore(path: string): ConsumedStore {
  const map = new Map<string, ConsumedRecord>();
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as ConsumedRegistry;
      for (const [invoiceNumber, rec] of Object.entries(data)) map.set(invoiceNumber, rec);
    } catch (e) {
      console.warn(`[uline-consumed] corrupt registry at ${path} — starting empty: ${(e as Error).message}`);
    }
  }
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(map), null, 2));
  };
  return {
    has: (invoiceNumber) => map.has(invoiceNumber),
    record: (invoiceNumber, txnId, entity) => {
      map.set(invoiceNumber, { txnId, entity, ts: new Date().toISOString() });
      flush();
    },
    all: () => Object.fromEntries(map),
  };
}
