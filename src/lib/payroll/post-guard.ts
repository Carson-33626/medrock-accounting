import type { ReconcileResult } from './types';
import type { HeaderStatus } from './store';

/**
 * Pure postability gate for POST /api/payroll/post.
 *
 * SAFETY GATE: a `mode: 'live'` post is only allowed when ALL of the following hold:
 *   - a decrypt key is configured (`hasKey`) — otherwise a live post would silently
 *     fall back to the fixture source and post fake data;
 *   - the header is not already `posted` — otherwise a retry / resubmit would double-post;
 *   - the draft is fully reconciled (`reconcile.postable === true`), which itself requires
 *     a REAL (non-empty-hardcoded) unmapped-columns/positions computation upstream.
 * `dry_run` is always allowed — it never touches QuickBooks.
 *
 * Kept pure + exported so it is unit-testable without mocking the DB or QuickBooks.
 */
export interface PostDecision {
  allowed: boolean;
  status: number;
  error?: string;
}

export function decidePost(input: {
  mode: 'dry_run' | 'live';
  reconcile: ReconcileResult;
  headerStatus: HeaderStatus;
  hasKey: boolean;
}): PostDecision {
  const { mode, reconcile, headerStatus, hasKey } = input;

  if (mode !== 'live') {
    return { allowed: true, status: 200 };
  }

  if (!hasKey) {
    return { allowed: false, status: 503, error: 'decrypt key not configured for live post' };
  }

  if (headerStatus === 'posted') {
    return { allowed: false, status: 409, error: 'already posted' };
  }

  if (!reconcile.postable) {
    return { allowed: false, status: 409, error: 'not postable' };
  }

  return { allowed: true, status: 200 };
}
