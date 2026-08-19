import { describe, it, expect } from 'vitest';
import { runSnapshotHash, sourceSnapshotHash } from './store';
import type { PayrollRow } from './types';
const mk = (rk: string, u: string, payDate = '07/17/2026', payGroup = 'MRFL'): PayrollRow =>
  ({ row_key: rk, updated_at: u, pay_date: payDate, pay_group: payGroup } as PayrollRow);
describe('sourceSnapshotHash', () => {
  it('is stable regardless of row order', () => {
    const a = sourceSnapshotHash([mk('1', 'x'), mk('2', 'y')]);
    const b = sourceSnapshotHash([mk('2', 'y'), mk('1', 'x')]);
    expect(a).toBe(b);
  });
  it('changes when a row updated_at changes (drift)', () => {
    const a = sourceSnapshotHash([mk('1', 'x')]);
    const b = sourceSnapshotHash([mk('1', 'z')]);
    expect(a).not.toBe(b);
  });
});

describe('runSnapshotHash', () => {
  it('build-time hash over a wide range EQUALS the post route recompute over day+group rows', () => {
    // The build fetches a whole month (many runs, many groups); the post route refetches
    // exactly one day filtered to one pay group. The stored and recomputed hashes must match
    // or the drift gate (post-guard I3) blocks every live post.
    const monthRows = [
      mk('a', 'x', '07/17/2026', 'MRFL'),
      mk('b', 'y', '07/17/2026', 'MRFL'),
      mk('c', 'z', '07/17/2026', 'MRTN'), // same day, other company
      mk('d', 'w', '07/31/2026', 'MRFL'), // other run, same company
    ];
    const postRecompute = sourceSnapshotHash([mk('b', 'y'), mk('a', 'x')]); // day+group, any order
    expect(runSnapshotHash(monthRows, '07/17/2026', 'MRFL')).toBe(postRecompute);
  });
  it('differs from the whole-range hash whenever the range holds more than the run', () => {
    const monthRows = [mk('a', 'x'), mk('c', 'z', '07/17/2026', 'MRTN')];
    expect(runSnapshotHash(monthRows, '07/17/2026', 'MRFL')).not.toBe(sourceSnapshotHash(monthRows));
  });
});
