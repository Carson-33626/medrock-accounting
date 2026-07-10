import type { ReconcileResult } from './types';

/**
 * Pure postability gate for POST /api/payroll/post.
 *
 * SAFETY GATE: a `mode: 'live'` post is only allowed when the draft is fully
 * reconciled (`reconcile.postable === true`). `dry_run` is always allowed —
 * it never touches QuickBooks. Kept pure + exported so it is unit-testable
 * without mocking the DB or QuickBooks.
 */
export function decidePostable(
  reconcile: ReconcileResult,
  mode: 'dry_run' | 'live',
): { allowed: boolean; status: number } {
  if (mode === 'live' && reconcile.postable !== true) {
    return { allowed: false, status: 409 };
  }
  return { allowed: true, status: 200 };
}
