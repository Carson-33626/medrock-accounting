import { describe, it, expect } from 'vitest';
import { sourceSnapshotHash } from './store';
import type { PayrollRow } from './types';
const mk = (rk: string, u: string): PayrollRow => ({ row_key: rk, updated_at: u } as PayrollRow);
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
