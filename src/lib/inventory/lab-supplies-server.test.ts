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
  // TN / TX through May (app lines only; Barbara's reversals are in QBO, below).
  { entity: 'MedRock TN', periodEnd: '2026-05-31', net: 2963.04 },
  { entity: 'MedRock TX', periodEnd: '2026-05-31', net: 5083.27 },
];

interface ReversalFixture {
  location: string;
  doc: string;
  date: string;
  amount: number;
}

/** Barbara's `Lab Accr Rev` JEs (Dr 2011 / Cr 5000.25). 26.06 is dated 06-01, AFTER May's end. */
const REVERSALS: ReversalFixture[] = [
  { location: 'MedRock FL', doc: 'FL Lab Accr Rev 26.05', date: '2026-05-01', amount: 1121.52 },
  { location: 'MedRock FL', doc: 'FL Lab Accr Rev 26.07', date: '2026-07-01', amount: 2442.51 },
  { location: 'MedRock FL', doc: 'FL Lab Accr Rev 26.08', date: '2026-08-01', amount: 2209.89 },
  { location: 'MedRock FL', doc: 'FL Lab Accr Rev 26.06', date: '2026-06-01', amount: 596.14 },
  { location: 'MedRock TN', doc: 'TN Lab Accr Rev 26.05', date: '2026-05-01', amount: 823.07 },
  { location: 'MedRock TN', doc: 'TN Lab Accr Rev 26.06', date: '2026-06-01', amount: 2139.97 },
  { location: 'MedRock TX', doc: 'TX Lab Accr Rev 26.05', date: '2026-05-01', amount: 3252.39 },
  { location: 'MedRock TX', doc: 'TX Lab Accr Rev 26.06', date: '2026-06-01', amount: 1830.88 },
];

let qbDown = false;

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

interface QbRow {
  Id: string;
  AcctNum?: string;
  DocNumber?: string;
  TxnDate?: string;
  Line?: {
    Amount: number;
    JournalEntryLineDetail: { PostingType: 'Debit' | 'Credit'; AccountRef: { name: string } };
  }[];
}
vi.mock('@/lib/quickbooks-multi', () => ({
  qbQueryAll: vi.fn(async (location: string, entityName: string): Promise<QbRow[]> => {
    if (qbDown) throw new Error('QuickBooks unreachable');
    if (entityName === 'Account') return [{ Id: '1', AcctNum: '1220.20' }];
    if (entityName !== 'JournalEntry') return [];
    return REVERSALS.filter((r) => r.location === location).map((r, i) => ({
      Id: String(i),
      DocNumber: r.doc,
      TxnDate: r.date,
      Line: [
        { Amount: r.amount, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'Accrued Expenses' } } },
        {
          Amount: r.amount,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { name: 'Cost of Goods Sold:Lab Supplies' } },
        },
      ],
    }));
  }),
}));

import { fetchPostedLabSuppliesToDate, labSuppliesContributionFor, netLabReversals } from './lab-supplies-server';

beforeEach(() => {
  query.mockClear();
  qbDown = false;
});

describe('fetchPostedLabSuppliesToDate — QBO actual lab balance (app lines less Lab Accr Rev)', () => {
  it('May actuals: FL 596.14, TN 2,139.97, TX 1,830.88 (06-01 reversals are not netted out of May)', async () => {
    expect(await fetchPostedLabSuppliesToDate('MedRock FL', '2026-05-31')).toBe(596.14);
    expect(await fetchPostedLabSuppliesToDate('MedRock TN', '2026-05-31')).toBe(2139.97);
    expect(await fetchPostedLabSuppliesToDate('MedRock TX', '2026-05-31')).toBe(1830.88);
  });

  it('through August FL is just August: the Jun-Aug reversals net the earlier accruals out', async () => {
    expect(await fetchPostedLabSuppliesToDate('MedRock FL', '2026-08-31')).toBe(2791.44);
  });

  it('sends the bound to the RDS query and the query uses it', async () => {
    await fetchPostedLabSuppliesToDate('MedRock FL', '2026-05-31');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('h.period_end::date <= $6::date');
    expect(params[5]).toBe('2026-05-31');
  });

  it('rejects when QuickBooks is unreachable instead of falling back to the RDS-only number', async () => {
    qbDown = true;
    await expect(fetchPostedLabSuppliesToDate('MedRock FL', '2026-05-31')).rejects.toThrow('unreachable');
  });
});

describe('netLabReversals', () => {
  const je = (doc: string, date: string, lines: [string, number, 'Debit' | 'Credit'][]) => ({
    Id: '1',
    DocNumber: doc,
    TxnDate: date,
    Line: lines.map(([name, Amount, PostingType]) => ({
      Amount,
      JournalEntryLineDetail: { PostingType, AccountRef: { name } },
    })),
  });

  it('counts only 2011 lines, only Lab Accr Rev docs, only through the bound', () => {
    const entries = [
      je('FL Lab Accr Rev 26.05', '2026-05-01', [['2011 Accrued Expenses', 100, 'Debit'], ['Cost of Goods Sold:Lab Supplies', 100, 'Credit']]),
      je('FL Lab Accr Rev 26.06', '2026-06-01', [['Accrued Expenses', 50, 'Debit']]),
      je('Inv Adj 2026.05-2', '2026-05-31', [['Accrued Expenses', 999, 'Debit']]),
    ];
    expect(netLabReversals(entries, '2026-05-31')).toBe(100);
  });
});

describe('labSuppliesContributionFor — correcting a non-latest month', () => {
  it('records and subtracts the QBO actual balance through THAT month', async () => {
    const { contribution, snapshot } = await labSuppliesContributionFor('MedRock FL', '2026-05');
    expect(query.mock.calls[0][1][5]).toBe('2026-05-31');
    expect(snapshot?.postedToDate).toBe(596.14);
    expect(contribution.delta).toBe(Math.round((contribution.target - 596.14) * 100) / 100);
  });

  it('reports unavailable (no snapshot) when QuickBooks cannot be read', async () => {
    qbDown = true;
    const { contribution, snapshot } = await labSuppliesContributionFor('MedRock FL', '2026-05');
    expect(contribution.available).toBe(false);
    expect(snapshot).toBeNull();
  });
});
