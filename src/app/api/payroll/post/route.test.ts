import { describe, it, expect } from 'vitest';
import { decidePostable } from '../../../../lib/payroll/post-guard';
import type { ReconcileResult } from '../../../../lib/payroll/types';

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

describe('decidePostable — LIVE QuickBooks posting safety gate', () => {
  it('REJECTS a non-postable draft for mode: live with 409 (no QB call should happen)', () => {
    const decision = decidePostable(notPostable, 'live');
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(409);
  });

  it('allows a postable draft for mode: live', () => {
    const decision = decidePostable(postable, 'live');
    expect(decision.allowed).toBe(true);
  });

  it('always allows mode: dry_run, even when not postable', () => {
    const decision = decidePostable(notPostable, 'dry_run');
    expect(decision.allowed).toBe(true);
  });
});
