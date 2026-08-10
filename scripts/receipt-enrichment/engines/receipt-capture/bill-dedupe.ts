// web/scripts/receipt-enrichment/engines/receipt-capture/bill-dedupe.ts
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
  /**
   * Invoice numbers on Ramp DRAFT bills. A separate fact from `rampInvoiceNumbers` because
   * `GET /bills` silently excludes drafts — the 2026-08-04 live pilot created a duplicate of a
   * draft the bookkeeper had already entered precisely because this layer did not exist.
   */
  rampDraftInvoiceNumbers: Set<string>;
}

export type DedupeVerdict = 'create' | 'skip_registry' | 'skip_quickbooks' | 'skip_ramp' | 'skip_draft';

/**
 * Leading zeros are stripped because QuickBooks does not preserve the vendor's padding: Medisca
 * invoice "03865107" is stored as DocNumber "3865107". Comparing raw would miss that match and
 * create a duplicate of a bill already in the books — the precise failure this module exists to
 * prevent. Letco's numbers ("C335-176896") carry no leading zeros, so they are unaffected.
 */
function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/^0+(?=.)/, '');
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
  if (hasKey(facts.rampDraftInvoiceNumbers, invoiceNumber)) return 'skip_draft';
  return 'create';
}
