import { describe, it, expect } from 'vitest';
import { decidePost } from '../../../../lib/payroll/post-guard';
import type { ReconcileResult } from '../../../../lib/payroll/types';
import type { HeaderStatus } from '../../../../lib/payroll/store';

const notPostable: ReconcileResult = {
  balanced: false,
  variance: 5,
  grossOk: true,
  netOk: true,
  taxesEeOk: true,
  taxesErOk: true,
  unmappedColumns: [],
  unmappedPositions: [],
  errors: ['Out of balance by 5.00'],
  postable: false,
};

const postable: ReconcileResult = {
  ...notPostable,
  balanced: true,
  variance: 0,
  errors: [],
  postable: true,
};

const base = (overrides: Partial<{
  mode: 'dry_run' | 'live';
  reconcile: ReconcileResult;
  headerStatus: HeaderStatus;
  hasKey: boolean;
  hasDrift: boolean;
}>): { mode: 'dry_run' | 'live'; reconcile: ReconcileResult; headerStatus: HeaderStatus; hasKey: boolean; hasDrift: boolean } => ({
  mode: 'live',
  reconcile: postable,
  headerStatus: 'approved',
  hasKey: true,
  hasDrift: false,
  ...overrides,
});

describe('decidePost — LIVE QuickBooks posting safety gate', () => {
  it('always allows mode: dry_run, even when not postable / no key / already posted', () => {
    const decision = decidePost(base({ mode: 'dry_run', reconcile: notPostable, hasKey: false, headerStatus: 'posted', hasDrift: true }));
    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe(200);
  });

  it('REJECTS a non-postable draft for mode: live with 409 (no QB call should happen)', () => {
    const decision = decidePost(base({ reconcile: notPostable }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(409);
    expect(decision.error).toBe('not postable');
  });

  it('REJECTS mode: live when the header is already posted, with 409 — even if postable (double-post guard)', () => {
    const decision = decidePost(base({ headerStatus: 'posted' }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(409);
    expect(decision.error).toBe('already posted');
  });

  it('REJECTS mode: live when no decrypt key is configured, with 503 (fail-closed, not fixture fallback)', () => {
    const decision = decidePost(base({ hasKey: false }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(503);
    expect(decision.error).toBe('decrypt key not configured for live post');
  });

  it('REJECTS mode: live when the header has not been approved yet, with 409', () => {
    const decision = decidePost(base({ headerStatus: 'needs_review' }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(409);
    expect(decision.error).toBe('must be approved before posting');
  });

  it('REJECTS mode: live when the source has drifted since the draft was built, with 409', () => {
    const decision = decidePost(base({ hasDrift: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(409);
    expect(decision.error).toMatch(/source changed/);
  });

  it('allows mode: live when approved, postable, keyed, not already posted, and no drift', () => {
    const decision = decidePost(base({}));
    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe(200);
  });
});
