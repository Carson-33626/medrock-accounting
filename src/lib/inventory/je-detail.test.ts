import { describe, it, expect } from 'vitest';
import { buildInventoryJeDetailSheets } from './je-detail';
import type { JeLotDetailRow } from './ledger-values';
import type { JournalLine } from '@/lib/payroll/types';

const MONTH_END = '2026-03-31';

function lot(overrides: Partial<JeLotDetailRow> & { receiptId: string }): JeLotDetailRow {
  return {
    location: 'MedRock Tennessee',
    qbCategory: 'Compound Ingredient',
    productName: 'TESTOSTERONE CYPIONATE',
    ndc: '00000-0000-00',
    lotNumber: 'L1',
    vendor: 'Medisca',
    dateReceived: '2026-02-10',
    qtyReceived: 10,
    unitCost: 5,
    totalCost: 50,
    qtyConsumed: 2,
    qtyRemaining: 8,
    remainingValue: 40,
    isOpeningBalance: false,
    lotAnchored: true,
    ...overrides,
  };
}

function line(overrides: Partial<JournalLine>): JournalLine {
  return {
    postingType: 'Debit',
    amount: 100,
    accountName: '1220.05 Compound Ingredient',
    departmentName: null,
    className: null,
    memo: 'Adjust Compound Ingredient inventory to FIFO (lot-level) as of 2026-03-31',
    creditBucket: null,
    origin: 'generated',
    sourceRowKeys: [],
    ...overrides,
  };
}

/** One category's balanced pair, as `categoryJournalEntryLinesWithSources` emits it. */
function pair(amount: number, receiptIds: string[], account = '1220.05 Compound Ingredient'): JournalLine[] {
  return amount > 0
    ? [
        line({ postingType: 'Debit', amount, accountName: account, sourceRowKeys: receiptIds }),
        line({ postingType: 'Credit', amount, accountName: '5000.05 Compound Ingredient', sourceRowKeys: receiptIds }),
      ]
    : [
        line({ postingType: 'Debit', amount: -amount, accountName: '5000.05 Compound Ingredient', sourceRowKeys: receiptIds }),
        line({ postingType: 'Credit', amount: -amount, accountName: account, sourceRowKeys: receiptIds }),
      ];
}

describe('buildInventoryJeDetailSheets', () => {
  it('states the FIFO value once per lot set, not once per posted line', () => {
    // Both halves of a Dr/Cr pair stand behind the SAME lots. Printing the value
    // on both would make the column total double the inventory it represents.
    const lines = pair(100, ['r1', 'r2']);
    const lots = [lot({ receiptId: 'r1', remainingValue: 40 }), lot({ receiptId: 'r2', remainingValue: 60 })];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    const posted = bridge.rows.filter((r) => r.account !== 'TOTAL');

    expect(posted[0].fifo_value).toBe(100);
    expect(posted[1].fifo_value).toBeNull();
    expect(bridge.rows.at(-1)?.fifo_value).toBe(100);
  });

  it('completes the bridge: FIFO minus the adjustment is the book balance', () => {
    // FIFO 100 against a book of 75 is a 25 debit to inventory.
    const lines = pair(25, ['r1']);
    const lots = [lot({ receiptId: 'r1', remainingValue: 100 })];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    expect(bridge.rows[0].implied_book).toBe(75);
  });

  it('reads the book balance the same way when FIFO came in BELOW book', () => {
    // FIFO 100 against a book of 130: a 30 credit to inventory, debit to COGS.
    const lines = pair(-30, ['r1']);
    const lots = [lot({ receiptId: 'r1', remainingValue: 100 })];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    // The COGS debit is emitted first on a negative adjustment; it carries the
    // value, and must not report the book balance as 70.
    expect(bridge.rows[0].implied_book).toBe(130);
  });

  it('totals debits and credits to the entry itself', () => {
    const lines = [...pair(25, ['r1']), ...pair(-10, ['r2'], '1220.10 Commercial Rx')];
    const lots = [lot({ receiptId: 'r1' }), lot({ receiptId: 'r2', qbCategory: 'Commercial Rx' })];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    const total = bridge.rows.at(-1);
    expect(total?.debit).toBe(35);
    expect(total?.credit).toBe(35);
  });

  it('counts a lot once even when both halves of the pair reach it', () => {
    const lines = pair(25, ['r1', 'r2']);
    const lots = [lot({ receiptId: 'r1', remainingValue: 40 }), lot({ receiptId: 'r2', remainingValue: 60 })];

    const [, detail] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    const rows = detail.rows.filter((r) => r.category !== 'TOTAL');
    expect(rows).toHaveLength(2);
    expect(detail.rows.at(-1)?.remaining_value).toBe(100);
  });

  it('foots the lot sheet to the FIFO value on the bridge', () => {
    const lines = [...pair(25, ['r1']), ...pair(-10, ['r2'], '1220.10 Commercial Rx')];
    const lots = [
      lot({ receiptId: 'r1', remainingValue: 1234.56 }),
      lot({ receiptId: 'r2', qbCategory: 'Commercial Rx', remainingValue: 765.44 }),
    ];

    const [bridge, detail] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    expect(bridge.rows.at(-1)?.fifo_value).toBe(2000);
    expect(detail.rows.at(-1)?.remaining_value).toBe(2000);
  });

  it('names every category behind the aggregated residual pair', () => {
    // Unmapped categories share one parent account and one book balance, so the
    // close emits ONE pair whose receipt ids span all of them.
    const lines = pair(50, ['r1', 'r2'], '1220 Inventory Asset');
    const lots = [
      lot({ receiptId: 'r1', qbCategory: 'Uncoded' }),
      lot({ receiptId: 'r2', qbCategory: 'Opening Balance' }),
    ];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    expect(bridge.rows[0].category).toBe('Opening Balance + Uncoded');
  });

  it('sums in cents so a split grouping cannot drift a penny', () => {
    const lines = pair(0.03, ['r1', 'r2', 'r3']);
    const lots = [
      lot({ receiptId: 'r1', remainingValue: 0.1 }),
      lot({ receiptId: 'r2', remainingValue: 0.2 }),
      lot({ receiptId: 'r3', remainingValue: 0.1 }),
    ];

    const [bridge] = buildInventoryJeDetailSheets(lines, lots, MONTH_END);
    expect(bridge.rows[0].fifo_value).toBe(0.4);
  });

  it('survives a line whose lots are no longer in the ledger', () => {
    // The draft stores receipt ids; a lot can vanish from the month (a category
    // exclusion, a re-run). The sheet must still build rather than throw.
    const lines = pair(25, ['gone']);
    const [bridge, detail] = buildInventoryJeDetailSheets(lines, [], MONTH_END);

    expect(bridge.rows[0].category).toBe('—');
    expect(bridge.rows[0].lots).toBe(0);
    expect(detail.rows).toHaveLength(0);
  });

  it('carries the close month into both sheet notes', () => {
    const sheets = buildInventoryJeDetailSheets(pair(25, ['r1']), [lot({ receiptId: 'r1' })], MONTH_END);
    expect(sheets.map((s) => s.name)).toEqual(['Category bridge', 'Lot detail']);
    for (const sheet of sheets) expect(sheet.note).toContain(MONTH_END);
  });
});
