import { describe, it, expect } from 'vitest';
import { sourceSnapshotHash } from './store';
import type { PayrollRow } from './types';
import { assertSharesSumTo100 } from './allocation';
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

describe('allocation rule set validation (guard reused by store)', () => {
  it('rejects a set that does not sum to 100 before any write', () => {
    expect(() => assertSharesSumTo100([33.3333, 33.3333, 33.3333])).toThrow(/sum to 100/);
  });
});
