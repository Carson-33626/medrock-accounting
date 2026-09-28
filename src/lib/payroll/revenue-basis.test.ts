import { describe, it, expect } from 'vitest';
import { revenueBasis, allocationIncomeNet, depositRevenueMoves, type RevenueMove } from './revenue-basis';
import { sharesFromRevenue, type EomEntity } from './revenue-rule';
import type { RawDeposit, RawJournalEntry } from './qb-pool';

const rec = (fl: number, tn: number, tx: number): Record<EomEntity, number> =>
  ({ 'MedRock FL': fl, 'MedRock TN': tn, 'MedRock TX': tx });

// May 2026, live QuickBooks 2026-09-28: the classed deposit revenue per direction.
const MAY_MOVES: RevenueMove[] = [
  { from: 'MedRock FL', to: 'MedRock TN', amount: 35172.78 },
  { from: 'MedRock FL', to: 'MedRock TX', amount: 94043.43 },
  { from: 'MedRock TN', to: 'MedRock FL', amount: 8976.98 },
  { from: 'MedRock TN', to: 'MedRock TX', amount: 808.0 },
];
const MAY_PL_POSTED = rec(912982.39, 1035200.3, 136001.21); // % Allo 2026.05 already posted
const MAY_ALLO_INCOME = rec(-120239.23, 25387.8, 94851.43);

describe('revenueBasis', () => {
  it('May after the allocation posted: lands on Barbara 43.81 / 49.67 / 6.53', () => {
    const inc = revenueBasis(MAY_PL_POSTED, MAY_ALLO_INCOME, MAY_MOVES);
    expect(inc).toEqual(rec(912982.39, 1035200.3, 136001.21));
    const s = sharesFromRevenue({ month: '2026-05', income: inc }) as Record<EomEntity, number>;
    expect(s['MedRock FL']).toBeCloseTo(43.81, 2);
    expect(s['MedRock TN']).toBeCloseTo(49.67, 2);
    expect(s['MedRock TX']).toBeCloseTo(6.53, 2);
  });

  it('May BEFORE the allocation posted gives the same basis (the bug month shape)', () => {
    const prePl = rec(912982.39 + 120239.23, 1035200.3 - 25387.8, 136001.21 - 94851.43);
    // The raw pre-move P&L is exactly what produced the wrong 49.57 / 48.45 / 1.97.
    const wrong = sharesFromRevenue({ month: '2026-05', income: prePl }) as Record<EomEntity, number>;
    expect(wrong['MedRock FL']).toBeCloseTo(49.57, 2);
    expect(wrong['MedRock TX']).toBeCloseTo(1.97, 2);
    expect(revenueBasis(prePl, rec(0, 0, 0), MAY_MOVES)).toEqual(rec(912982.39, 1035200.3, 136001.21));
  });
});

describe('allocationIncomeNet', () => {
  const je = (id: string, doc: string, date: string, lines: [string, 'Debit' | 'Credit', number][]): RawJournalEntry => ({
    Id: id, DocNumber: doc, TxnDate: date,
    Line: lines.map(([acct, pt, amt]) => ({ Amount: amt, JournalEntryLineDetail: { PostingType: pt, AccountRef: { value: acct } } })),
  });
  const income = new Set(['79']);
  const may = { year: 2026, month: 5 };

  it('nets income lines of in-month % Allo family entries, credit-positive', () => {
    const entries = [
      je('1', 'FL % Allo 2026.05', '2026-05-31', [['79', 'Debit', 129216.21], ['79', 'Credit', 8976.98], ['900', 'Credit', 120239.23]]),
      je('2', '% Allo 2026.05B', '2026-05-31', [['79', 'Credit', 10]]),
    ];
    expect(allocationIncomeNet(entries, income, may)).toBe(-120229.23);
  });

  it('ignores other docs, other months, and non-income accounts', () => {
    const entries = [
      je('1', 'SalesTaxAccru 2026.05', '2026-05-31', [['79', 'Debit', 10.28]]),
      je('2', 'FL % Allo 2026.04', '2026-05-31', [['79', 'Debit', 5]]),
      je('3', 'FL % Allo 2026.05', '2026-06-01', [['79', 'Debit', 5]]),
      je('4', 'FL CS Allo 2026.05', '2026-05-31', [['79', 'Debit', 5]]),
      je('5', 'FL % Allo 2026.05', '2026-05-31', [['900', 'Debit', 5]]),
    ];
    expect(allocationIncomeNet(entries, income, may)).toBe(0);
  });
});

describe('depositRevenueMoves', () => {
  const dep = (lines: [string, string | null, number][]): RawDeposit => ({
    Id: 'd1',
    Line: lines.map(([acct, cls, amt]) => ({
      Amount: amt, DepositLineDetail: { AccountRef: { value: acct }, ClassRef: cls === null ? undefined : { name: cls } },
    })),
  });
  const income = new Set(['79']);

  it('directed Allocate classes on income lines become moves', () => {
    const moves = depositRevenueMoves([dep([['79', 'Allocate - TX', 500], ['79', 'Allocate - TN', 20], ['79', null, 1000]])], 'MedRock FL', income);
    expect(moves).toEqual([
      { from: 'MedRock FL', to: 'MedRock TX', amount: 500 },
      { from: 'MedRock FL', to: 'MedRock TN', amount: 20 },
    ]);
  });

  it('skips non-income accounts, pooled classes, and self-classed lines', () => {
    const moves = depositRevenueMoves([dep([['900', 'Allocate - TX', 3300], ['79', 'Allocate - %', 50], ['79', 'Allocate - FL', 9]])], 'MedRock FL', income);
    expect(moves).toEqual([]);
  });
});
