import { describe, it, expect } from 'vitest';
import { runSnapshotHash, sourceSnapshotHash } from './store';
import type { PayrollRow, SensitiveRow } from './types';

const mk = (
  rk: string,
  u: string,
  payDate = '07/17/2026',
  payGroup = 'MRFL',
  extra: Partial<PayrollRow> = {},
): PayrollRow =>
  ({
    row_key: rk,
    updated_at: u,
    pay_date: payDate,
    pay_group: payGroup,
    position_id: '000102',
    name: 'Doe, Jane',
    status: 'Active',
    worker_classification: '',
    home_department: 'FL Region',
    location: 'FL',
    pay_num: '1',
    pay_frequency: 'Biweekly',
    pay_type: 'Regular',
    period_start_date: '07/01/2026',
    period_end_date: '07/14/2026',
    processed_as: 'Pay Anytime',
    rate_type: 'Hourly',
    sui_sdi_tax_code: 'FL',
    sensitive: { 'Net Pay': 1234.56, 'Regular Hours': 80 } as SensitiveRow,
    ...extra,
  } as PayrollRow);

describe('sourceSnapshotHash', () => {
  it('is stable regardless of row order', () => {
    const a = sourceSnapshotHash([mk('1', 'x'), mk('2', 'y')]);
    const b = sourceSnapshotHash([mk('2', 'y'), mk('1', 'x')]);
    expect(a).toBe(b);
  });

  /**
   * THE 2026-08-20 REGRESSION. `source.payroll_history` is loaded WINDOWED_REPLACE: every ADP
   * ingest DELETEs the whole pay-date window and re-INSERTs it with `updated_at = now()`,
   * whether or not a single number changed. While this hash keyed on `updated_at`, every
   * nightly load marked every draft in the window as "source changed since draft was built",
   * so Barbara's approved June JEs could not be posted the morning after any ingest.
   * The hash therefore covers row CONTENT and must ignore `updated_at` entirely.
   */
  it('ignores updated_at churn — a no-op re-ingest is NOT drift', () => {
    const before = sourceSnapshotHash([mk('1', '2026-08-13T22:13:48.547'), mk('2', '2026-08-13T22:13:48.547')]);
    const after = sourceSnapshotHash([mk('1', '2026-08-19T22:17:52.139'), mk('2', '2026-08-19T22:17:52.139')]);
    expect(after).toBe(before);
  });

  it('changes when a sensitive amount changes (real drift)', () => {
    const a = sourceSnapshotHash([mk('1', 'x')]);
    const b = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { 'Net Pay': 1234.57, 'Regular Hours': 80 } })]);
    expect(a).not.toBe(b);
  });

  it('changes when a sensitive column is added or removed (real drift)', () => {
    const a = sourceSnapshotHash([mk('1', 'x')]);
    const b = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { 'Net Pay': 1234.56, 'Regular Hours': 80, Bonus: 500 } })]);
    expect(a).not.toBe(b);
  });

  it('changes when a plaintext business field changes (real drift)', () => {
    const a = sourceSnapshotHash([mk('1', 'x')]);
    const b = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { home_department: 'OH Region' })]);
    expect(a).not.toBe(b);
  });

  it('changes when a row is added or removed (real drift)', () => {
    const a = sourceSnapshotHash([mk('1', 'x')]);
    const b = sourceSnapshotHash([mk('1', 'x'), mk('2', 'x')]);
    expect(a).not.toBe(b);
  });

  it('is insensitive to number-vs-numeric-string representation of the same amount', () => {
    const a = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { 'Net Pay': 1234.5 } })]);
    const b = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { 'Net Pay': '1234.50' } })]);
    expect(a).toBe(b);
  });

  it('does not confuse a null sensitive value with an empty string', () => {
    const a = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { Bonus: null } })]);
    const b = sourceSnapshotHash([mk('1', 'x', '07/17/2026', 'MRFL', { sensitive: { Bonus: '' } })]);
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
