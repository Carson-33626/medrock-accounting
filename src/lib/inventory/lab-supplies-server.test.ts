import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * REGRESSION (2026-10-27 close map §5): `fetchPostedLabSuppliesToDate` summed every posted lab
 * line with no period bound, while the TARGET it is subtracted from covers months up to the close
 * month only. Correcting a non-latest month therefore also reversed every LATER month's accrual
 * (FL May: 8,207.10 booked, 763.26 right). The posted side must stop at the close month's end.
 *
 * The pool here emulates only the bound the SQL applies ($6 = through-month-end), over the real
 * 2026-10-27 posted FL lab lines, so the test fails if the caller stops passing the month end or the
 * query stops using it.
 */

interface PostedLabLine {
  entity: string;
  periodEnd: string;
  net: number;
}

const POSTED: PostedLabLine[] = [
  { entity: 'MedRock FL', periodEnd: '2026-01-31', net: 136.08 },
  { entity: 'MedRock FL', periodEnd: '2026-02-28', net: 225.19 },
  { entity: 'MedRock FL', periodEnd: '2026-03-31', net: 325.39 },
  { entity: 'MedRock FL', periodEnd: '2026-04-30', net: 434.86 },
  { entity: 'MedRock FL', periodEnd: '2026-05-31', net: 596.14 },
  { entity: 'MedRock FL', periodEnd: '2026-06-30', net: 2442.51 },
  { entity: 'MedRock FL', periodEnd: '2026-07-31', net: 2209.89 },
  { entity: 'MedRock FL', periodEnd: '2026-08-31', net: 2791.44 },
];

const query = vi.fn(async (sql: string, params: readonly string[]) => {
  const [entity] = params;
  const bound = /h\.period_end::date <= \$6::date/.test(sql) ? params[5] : null;
  const total = POSTED.filter((l) => l.entity === entity && (bound === null || l.periodEnd <= bound)).reduce(
    (s, l) => s + l.net,
    0,
  );
  return { rows: [{ net: total.toFixed(2) }] };
});

vi.mock('@/lib/rds', () => ({ getRdsPool: () => ({ query }) }));

interface QbAccount {
  Id: string;
  AcctNum: string;
}
vi.mock('@/lib/quickbooks-multi', () => ({
  qbQueryAll: vi.fn(async (_location: string, entityName: string): Promise<QbAccount[]> =>
    entityName === 'Account' ? [{ Id: '1', AcctNum: '1220.20' }] : [],
  ),
}));

import { fetchPostedLabSuppliesToDate, labSuppliesContributionFor } from './lab-supplies-server';

beforeEach(() => {
  query.mockClear();
});

describe('fetchPostedLabSuppliesToDate', () => {
  it('stops at the close month: FL through May is 1,717.66, not the all-time 9,161.50', async () => {
    expect(await fetchPostedLabSuppliesToDate('MedRock FL', '2026-05-31')).toBe(1717.66);
  });

  it('through the latest posted month it equals the all-time figure', async () => {
    expect(await fetchPostedLabSuppliesToDate('MedRock FL', '2026-08-31')).toBe(9161.5);
  });

  it('sends the bound to the query and the query uses it', async () => {
    await fetchPostedLabSuppliesToDate('MedRock FL', '2026-05-31');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('h.period_end::date <= $6::date');
    expect(params[5]).toBe('2026-05-31');
  });
});

describe('labSuppliesContributionFor — correcting a non-latest month', () => {
  it('records and subtracts only the posted accruals through THAT month', async () => {
    const { contribution, snapshot } = await labSuppliesContributionFor('MedRock FL', '2026-05');
    expect(query.mock.calls[0][1][5]).toBe('2026-05-31');
    expect(snapshot?.postedToDate).toBe(1717.66);
    // delta = target − posted-through-May; the June to August accruals (7,443.84) stay out of it.
    expect(contribution.delta).toBe(Math.round((contribution.target - 1717.66) * 100) / 100);
    expect(contribution.delta).not.toBe(Math.round((contribution.target - 9161.5) * 100) / 100);
  });

  it('the latest month is unaffected: bounded and unbounded agree', async () => {
    const { snapshot } = await labSuppliesContributionFor('MedRock FL', '2026-08');
    expect(query.mock.calls[0][1][5]).toBe('2026-08-31');
    expect(snapshot?.postedToDate).toBe(9161.5);
  });
});
