import { describe, it, expect } from 'vitest';
import { decidePost } from './post-guard';
import type { ReconcileResult } from './types';

const postableReconcile: ReconcileResult = {
  balanced: true,
  variance: 0,
  grossOk: true,
  netOk: true,
  taxesEeOk: true,
  taxesErOk: true,
  unmappedColumns: [],
  unmappedPositions: [],
  errors: [],
  postable: true,
};

const notPostableReconcile: ReconcileResult = {
  ...postableReconcile,
  postable: false,
  errors: ['nope'],
};

describe('decidePost', () => {
  it('always allows dry_run', () => {
    const d = decidePost({
      mode: 'dry_run',
      reconcile: notPostableReconcile,
      headerStatus: 'draft',
      hasKey: false,
      hasDrift: true,
    });
    expect(d.allowed).toBe(true);
  });

  it('blocks live post with no decrypt key configured', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: postableReconcile,
      headerStatus: 'approved',
      hasKey: false,
      hasDrift: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(503);
  });

  it('blocks live post when header already posted', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: postableReconcile,
      headerStatus: 'posted',
      hasKey: true,
      hasDrift: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(409);
    expect(d.error).toMatch(/already posted/);
  });

  it('blocks live post when header is not approved', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: postableReconcile,
      headerStatus: 'needs_review',
      hasKey: true,
      hasDrift: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(409);
    expect(d.error).toMatch(/must be approved/);
  });

  it('blocks live post when draft is not postable', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: notPostableReconcile,
      headerStatus: 'approved',
      hasKey: true,
      hasDrift: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(409);
    expect(d.error).toMatch(/not postable/);
  });

  it('blocks live post when source has drifted since draft was built', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: postableReconcile,
      headerStatus: 'approved',
      hasKey: true,
      hasDrift: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(409);
    expect(d.error).toMatch(/source changed/);
  });

  it('allows live post when approved, postable, keyed, and no drift', () => {
    const d = decidePost({
      mode: 'live',
      reconcile: postableReconcile,
      headerStatus: 'approved',
      hasKey: true,
      hasDrift: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.status).toBe(200);
  });
});
