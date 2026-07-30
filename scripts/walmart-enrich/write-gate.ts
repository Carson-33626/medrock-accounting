// Which writes a matched Ramp transaction may receive. Pure, so the decision table is testable without
// touching Ramp.
//
// Split and attach are gated SEPARATELY because they fail independently: a transaction can carry a receipt
// but no GL split, or a split but no receipt. Both sit behind one shared precondition — the transaction
// must still be open. run-cdp-split.ts previously had no state check at all and PATCHed whatever the
// matcher handed it, which produced 12 `write_fail HTTP 403` against locked transactions on 2026-07-30.
import type { RampTxn } from '../ramp-split-push/types';

export interface WriteDecision {
  canSplit: boolean;
  canAttach: boolean;
  /** set_aside reason when NOTHING may be written; null when at least one write is allowed */
  blockedReason: string | null;
}

// Already enriched by us = a real multi-line split OR a single line carrying a product memo (mirrors
// run.ts / amazon-enrich isEnriched). priorLineItems is `unknown` on RampTxn — narrow before inspecting.
export function isTxnEnriched(priorLineItems: unknown): boolean {
  if (!Array.isArray(priorLineItems)) return false;
  const lines = priorLineItems as unknown[];
  if (lines.length > 1) return true;
  return lines.some((l) => {
    if (typeof l !== 'object' || l === null) return false;
    const memo = (l as { memo?: unknown }).memo;
    return typeof memo === 'string' && memo.trim().length > 0;
  });
}

export function decideWrites(txn: RampTxn): WriteDecision {
  const blocked = (reason: string): WriteDecision => ({ canSplit: false, canAttach: false, blockedReason: reason });

  // Unknown state reads as ineligible: these fields are absent only on transactions fetched by an older
  // path, and guessing "probably fine" on a write to a possibly-reconciled transaction is the wrong bet.
  if (txn.state == null || txn.syncStatus == null) return blocked('state_unknown');
  if (txn.state !== 'CLEARED') return blocked('not_cleared');
  if (txn.syncStatus === 'SYNCED') return blocked('already_synced');
  if (txn.syncStatus !== 'NOT_SYNC_READY') return blocked(`sync_status_${txn.syncStatus.toLowerCase()}`);

  const canSplit = !isTxnEnriched(txn.priorLineItems);
  // No receipt-delete API on Ramp: a second upload is permanent, so absence of the count reads as "may
  // already have one".
  const canAttach = txn.receiptCount === 0;
  if (!canSplit && !canAttach) return blocked('already_enriched_and_receipted');
  return { canSplit, canAttach, blockedReason: null };
}
