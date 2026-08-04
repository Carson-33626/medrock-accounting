// scripts/receipt-capture/bill-consumed.ts
//
// Local record of Letco/Fagron invoices we have already turned into Ramp draft bills. Ramp's
// draft-bill create has no idempotency key, so this file is the ONLY thing preventing a crashed
// run from re-creating a duplicate bill on retry.
//
// Mirrors uline-consumed.ts: atomic flush (temp file + rename, so a crash mid-write can never
// leave a truncated registry that reads as "nothing consumed"), and a corrupt file is FLAGGED
// rather than silently treated as empty — an empty-looking registry would re-create every bill.
// The orchestrator hard-stops on `corrupt` in --live mode.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ConsumedBillEntry {
  draftId: string;
  entity: string;
  ts: string;
}

export interface ConsumedBillStore {
  has(invoiceNumber: string): boolean;
  record(invoiceNumber: string, draftId: string, entity: string): void;
  all(): Record<string, ConsumedBillEntry>;
  // True when a registry file existed at load time but failed to parse. The store still starts
  // empty (see below) but the caller needs to know this happened — "empty" is otherwise
  // indistinguishable from a brand-new registry, and a --live run must not silently risk
  // re-creating every already-consumed bill on top of a corrupt file it can no longer read.
  corrupt: boolean;
}

// Lookup is lowercased + trimmed (matching bill-dedupe's normalisation), so invoice numbers that
// differ only in case or stray whitespace still collide on the same entry. The registry itself
// stores entries under the invoice number exactly as passed to record() — `all()` returns
// original casing — with a parallel normalised index used only to answer has().
const normalizeKey = (invoiceNumber: string): string => invoiceNumber.trim().toLowerCase();

export function loadConsumedBillStore(path: string): ConsumedBillStore {
  const entries = new Map<string, ConsumedBillEntry>(); // original-casing invoice number -> entry
  const index = new Map<string, string>(); // normalized key -> original-casing invoice number
  let corrupt = false;
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ConsumedBillEntry>;
      for (const [invoiceNumber, entry] of Object.entries(data)) {
        entries.set(invoiceNumber, entry);
        index.set(normalizeKey(invoiceNumber), invoiceNumber);
      }
    } catch (e) {
      corrupt = true;
      console.warn(`[bill-consumed] corrupt registry at ${path} — starting empty: ${(e as Error).message}`);
    }
  }
  // Atomic flush: write to a sibling .tmp file then rename over the real path. A rename is a
  // single filesystem operation (no partial-write window), so a crash mid-flush leaves either the
  // old file intact or the new one fully written — never a half-written JSON file that would trip
  // the corrupt path above on the next load.
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(entries), null, 2));
    renameSync(tmpPath, path);
  };
  return {
    corrupt,
    has: (invoiceNumber: string): boolean => index.has(normalizeKey(invoiceNumber)),
    record: (invoiceNumber: string, draftId: string, entity: string): void => {
      entries.set(invoiceNumber, { draftId, entity, ts: new Date().toISOString() });
      index.set(normalizeKey(invoiceNumber), invoiceNumber);
      flush();
    },
    all: (): Record<string, ConsumedBillEntry> => Object.fromEntries(entries),
  };
}
