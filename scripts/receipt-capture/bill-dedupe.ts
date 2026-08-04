// web/scripts/receipt-capture/bill-dedupe.ts
// A duplicate bill in the system of record is the failure that matters here, so dedupe is layered
// and checks BOTH systems: 77% of Letco bills are hand-keyed into QuickBooks and 23% arrive via
// Ramp Bill Pay, so checking one source would duplicate the other.
//
// The local registry is checked FIRST: Ramp's draft-create has no idempotency key, so a run that
// crashed after creating a draft must not create it again on the next pass.

export interface DedupeFacts {
  inRegistry: boolean;
  qbDocNumbers: Set<string>;
  rampInvoiceNumbers: Set<string>;
}

export type DedupeVerdict = 'create' | 'skip_registry' | 'skip_quickbooks' | 'skip_ramp';

function normalizeKey(s: string): string {
  return s.trim().toLowerCase();
}

function hasKey(set: Set<string>, key: string): boolean {
  const target = normalizeKey(key);
  for (const v of set) if (normalizeKey(v) === target) return true;
  return false;
}

export function dedupeVerdict(invoiceNumber: string, facts: DedupeFacts): DedupeVerdict {
  if (facts.inRegistry) return 'skip_registry';
  if (hasKey(facts.qbDocNumbers, invoiceNumber)) return 'skip_quickbooks';
  if (hasKey(facts.rampInvoiceNumbers, invoiceNumber)) return 'skip_ramp';
  return 'create';
}
