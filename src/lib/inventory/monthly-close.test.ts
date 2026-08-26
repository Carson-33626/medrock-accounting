import { describe, it, expect } from 'vitest';
import {
  buildRollForward,
  buildLocationJE,
  journalEntryLines,
  findCloseHeader,
  closeDisplayLines,
  closeJeSheetNote,
  INVENTORY_ACCOUNT,
  COGS_ACCOUNT,
  buildCategoryRollForward,
  buildCategoryJE,
  categoryJournalEntryLines,
  categoryJournalEntryLinesWithSources,
  sumCents,
  wasteShrinkPostingLines,
  type RollbackMonthValue,
  type CategoryLedgerValue,
} from './monthly-close';
import { WASTE_ACCOUNT } from './category-accounts';
import type { InvCloseHeader, InvCloseLine } from '@/types/inventory';

const mv = (over: Partial<RollbackMonthValue> & { location: string }): RollbackMonthValue => ({
  valueFloor: null,
  valueFull: null,
  purchasesFloor: null,
  purchasesFull: null,
  ...over,
});

describe('buildRollForward', () => {
  it('derives COGS as Beginning + Purchases − Ending per location (floor basis)', () => {
    const prior = [mv({ location: 'MedRock FL', valueFloor: 1000 })];
    const current = [mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: 500 })];
    const rows = buildRollForward(current, prior, 'floor', true);
    const fl = rows.find((r) => r.label === 'MedRock FL');
    expect(fl?.beginning).toBe(1000);
    expect(fl?.purchases).toBe(500);
    expect(fl?.ending).toBe(1200);
    expect(fl?.cogs).toBe(300); // 1000 + 500 − 1200
    expect(fl?.windowStart).toBe(false);
    expect(fl?.purchasesPending).toBe(false);
  });

  it('selects the full-basis columns when basis = full', () => {
    const prior = [mv({ location: 'MedRock FL', valueFloor: 1000, valueFull: 1500 })];
    const current = [
      mv({ location: 'MedRock FL', valueFloor: 1200, valueFull: 1800, purchasesFloor: 500, purchasesFull: 700 }),
    ];
    const rows = buildRollForward(current, prior, 'full', true);
    const fl = rows.find((r) => r.label === 'MedRock FL');
    expect(fl?.beginning).toBe(1500);
    expect(fl?.purchases).toBe(700);
    expect(fl?.ending).toBe(1800);
    expect(fl?.cogs).toBe(400); // 1500 + 700 − 1800
  });

  it('marks the earliest month as window start: null beginning and null COGS', () => {
    const current = [mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: 500 })];
    const rows = buildRollForward(current, null, 'floor', true);
    const fl = rows.find((r) => r.label === 'MedRock FL');
    expect(fl?.windowStart).toBe(true);
    expect(fl?.beginning).toBeNull();
    expect(fl?.cogs).toBeNull();
    expect(fl?.purchases).toBe(500); // purchases still shown
    expect(fl?.ending).toBe(1200);
  });

  it('degrades to null purchases and null COGS when purchases columns are unavailable', () => {
    const prior = [mv({ location: 'MedRock FL', valueFloor: 1000 })];
    const current = [mv({ location: 'MedRock FL', valueFloor: 1200 })];
    const rows = buildRollForward(current, prior, 'floor', false);
    const fl = rows.find((r) => r.label === 'MedRock FL');
    expect(fl?.purchases).toBeNull();
    expect(fl?.purchasesPending).toBe(true);
    expect(fl?.cogs).toBeNull();
    expect(fl?.beginning).toBe(1000); // beginning still derived from prior month
  });

  it('treats a per-row NULL purchases value as pending even when the columns exist', () => {
    const prior = [mv({ location: 'MedRock FL', valueFloor: 1000 })];
    const current = [mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: null })];
    const rows = buildRollForward(current, prior, 'floor', true);
    const fl = rows.find((r) => r.label === 'MedRock FL');
    expect(fl?.purchases).toBeNull();
    expect(fl?.cogs).toBeNull();
  });

  it('treats a location new this month (absent last month) as beginning zero', () => {
    const prior = [mv({ location: 'MedRock FL', valueFloor: 1000 })];
    const current = [
      mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: 500 }),
      mv({ location: 'MedRock TX', valueFloor: 300, purchasesFloor: 300 }),
    ];
    const rows = buildRollForward(current, prior, 'floor', true);
    const tx = rows.find((r) => r.label === 'MedRock TX');
    expect(tx?.beginning).toBe(0);
    expect(tx?.cogs).toBe(0); // 0 + 300 − 300
  });

  it('appends a Total row summing every location and deriving its COGS', () => {
    const prior = [
      mv({ location: 'MedRock FL', valueFloor: 1000 }),
      mv({ location: 'MedRock TN', valueFloor: 2000 }),
    ];
    const current = [
      mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: 500 }),
      mv({ location: 'MedRock TN', valueFloor: 2100, purchasesFloor: 400 }),
    ];
    const rows = buildRollForward(current, prior, 'floor', true);
    const total = rows.find((r) => r.cut === 'total');
    expect(total?.beginning).toBe(3000);
    expect(total?.purchases).toBe(900);
    expect(total?.ending).toBe(3300);
    expect(total?.cogs).toBe(600); // 3000 + 900 − 3300
  });

  it('makes the Total row pending if any location is missing purchases', () => {
    const prior = [
      mv({ location: 'MedRock FL', valueFloor: 1000 }),
      mv({ location: 'MedRock TN', valueFloor: 2000 }),
    ];
    const current = [
      mv({ location: 'MedRock FL', valueFloor: 1200, purchasesFloor: 500 }),
      mv({ location: 'MedRock TN', valueFloor: 2100, purchasesFloor: null }),
    ];
    const rows = buildRollForward(current, prior, 'floor', true);
    const total = rows.find((r) => r.cut === 'total');
    expect(total?.purchases).toBeNull();
    expect(total?.cogs).toBeNull();
  });

  it('sorts location rows by descending ending value', () => {
    const current = [
      mv({ location: 'MedRock TX', valueFloor: 300 }),
      mv({ location: 'MedRock FL', valueFloor: 1200 }),
      mv({ location: 'MedRock TN', valueFloor: 800 }),
    ];
    const rows = buildRollForward(current, null, 'floor', true);
    const locationLabels = rows.filter((r) => r.cut === 'location').map((r) => r.label);
    expect(locationLabels).toEqual(['MedRock FL', 'MedRock TN', 'MedRock TX']);
  });
});

describe('buildLocationJE', () => {
  it('computes a positive adjustment (FIFO above book) → debit inventory', () => {
    const je = buildLocationJE('MedRock FL', 1200, 1000, []);
    expect(je.adjustment).toBe(200);
    expect(je.bookAvailable).toBe(true);
    expect(je.direction).toBe('debit-inventory');
  });

  it('computes a negative adjustment (FIFO below book) → credit inventory', () => {
    const je = buildLocationJE('MedRock FL', 900, 1000, []);
    expect(je.adjustment).toBe(-100);
    expect(je.direction).toBe('credit-inventory');
  });

  it('returns no direction and null adjustment when the book balance is unavailable', () => {
    const je = buildLocationJE('MedRock FL', 900, null, []);
    expect(je.bookAvailable).toBe(false);
    expect(je.adjustment).toBeNull();
    expect(je.direction).toBeNull();
  });

  it('marks a zero adjustment as none', () => {
    const je = buildLocationJE('MedRock FL', 1000, 1000, []);
    expect(je.adjustment).toBe(0);
    expect(je.direction).toBe('none');
  });
});

describe('journalEntryLines', () => {
  it('books Dr Inventory / Cr COGS for a positive adjustment', () => {
    const je = buildLocationJE('MedRock FL', 1200, 1000, []);
    const lines = journalEntryLines(je, 'floor', '2026-06-30');
    expect(lines).toHaveLength(2);
    const dr = lines.find((l) => l.debit !== null);
    const cr = lines.find((l) => l.credit !== null);
    expect(dr?.account).toBe(INVENTORY_ACCOUNT);
    expect(dr?.debit).toBe(200);
    expect(cr?.account).toBe(COGS_ACCOUNT);
    expect(cr?.credit).toBe(200);
    expect(dr?.memo).toBe('Adjust inventory to FIFO (rollback, floor) as of 2026-06-30');
  });

  it('reverses to Dr COGS / Cr Inventory for a negative adjustment', () => {
    const je = buildLocationJE('MedRock FL', 900, 1000, []);
    const lines = journalEntryLines(je, 'full', '2026-06-30');
    const dr = lines.find((l) => l.debit !== null);
    const cr = lines.find((l) => l.credit !== null);
    expect(dr?.account).toBe(COGS_ACCOUNT);
    expect(dr?.debit).toBe(100);
    expect(cr?.account).toBe(INVENTORY_ACCOUNT);
    expect(cr?.credit).toBe(100);
  });

  it('returns no lines when the adjustment is zero or the book is unavailable', () => {
    expect(journalEntryLines(buildLocationJE('X', 1000, 1000, []), 'floor', '2026-06-30')).toHaveLength(0);
    expect(journalEntryLines(buildLocationJE('X', 1000, null, []), 'floor', '2026-06-30')).toHaveLength(0);
  });
});

const header = (over: Partial<InvCloseHeader> & { id: number; entity: string }): InvCloseHeader => ({
  status: 'draft',
  qb_doc_number: null,
  txn_date: null,
  total_debits: 0,
  total_credits: 0,
  variance: 0,
  ...over,
});

const storedLine = (over: Partial<InvCloseLine>): InvCloseLine => ({
  postingType: 'Debit',
  amount: 0,
  accountName: INVENTORY_ACCOUNT,
  memo: 'stored',
  ...over,
});

describe('findCloseHeader', () => {
  it('matches a QB-named header to an RDS-named location via the short label', () => {
    const headers = [header({ id: 1, entity: 'MedRock FL' }), header({ id: 2, entity: 'MedRock TN' })];
    expect(findCloseHeader('MedRock Florida', headers)?.id).toBe(1);
    expect(findCloseHeader('MedRock Tennessee', headers)?.id).toBe(2);
  });

  it('returns null when no draft exists for the location', () => {
    expect(findCloseHeader('MedRock Texas', [header({ id: 1, entity: 'MedRock FL' })])).toBeNull();
  });
});

describe('closeDisplayLines', () => {
  const je = buildLocationJE('MedRock Florida', 1200, 1000, []); // suggestion would be a 200 adjustment

  it('returns the STORED draft lines when a draft header exists — never the recomputed suggestion', () => {
    const stored = [
      storedLine({ postingType: 'Debit', amount: 350, accountName: INVENTORY_ACCOUNT }),
      storedLine({ postingType: 'Credit', amount: 350, accountName: COGS_ACCOUNT }),
    ];
    const lines = closeDisplayLines(je, header({ id: 1, entity: 'MedRock FL' }), stored, 'floor', '2026-06-30');
    expect(lines).toBe(stored); // the frozen lines, untouched
    expect(lines[0]?.amount).toBe(350); // not the live 200 suggestion
  });

  it('returns stored lines even when they are empty for a drafted location', () => {
    expect(closeDisplayLines(je, header({ id: 1, entity: 'MedRock FL' }), [], 'floor', '2026-06-30')).toHaveLength(0);
  });

  it('falls back to the computed suggestion, mapped to stored-line shape, without a draft', () => {
    const lines = closeDisplayLines(je, null, [], 'floor', '2026-06-30');
    expect(lines).toEqual([
      {
        postingType: 'Debit',
        amount: 200,
        accountName: INVENTORY_ACCOUNT,
        memo: 'Adjust inventory to FIFO (rollback, floor) as of 2026-06-30',
      },
      {
        postingType: 'Credit',
        amount: 200,
        accountName: COGS_ACCOUNT,
        memo: 'Adjust inventory to FIFO (rollback, floor) as of 2026-06-30',
      },
    ]);
  });
});

describe('closeJeSheetNote', () => {
  const fl = buildLocationJE('MedRock Florida', 1200, 1000, []);
  const tn = buildLocationJE('MedRock Tennessee', 900, 1000, []);

  it('states SUGGESTED ONLY when no drafts have been generated', () => {
    const note = closeJeSheetNote([fl, tn], [], '2026-07');
    expect(note).toContain('SUGGESTED ONLY');
    expect(note).toContain('nothing is posted');
  });

  it('reports each draft location with its DocNumber and status label', () => {
    const headers = [header({ id: 1, entity: 'MedRock FL', status: 'approved' })];
    const note = closeJeSheetNote([fl, tn], headers, '2026-07');
    expect(note).toContain('STORED DRAFT');
    expect(note).toContain('FL: FL Inv Adj 2026.07 — Approved');
    expect(note).toContain('TN: live suggestion (no draft)');
  });

  it('uses the QuickBooks-assigned DocNumber once posted', () => {
    const headers = [header({ id: 1, entity: 'MedRock FL', status: 'posted', qb_doc_number: 'QB-123' })];
    const note = closeJeSheetNote([fl], headers, '2026-07');
    expect(note).toContain('FL: QB-123 — Posted');
  });
});

describe('QuickBooks account constants', () => {
  // These strings are looked up in refs.accounts (keyed by the Account entity's
  // FullyQualifiedName) by buildJePayload, which THROWS on a miss. The
  // BalanceSheet report calls the same account '1220 Inventory Asset', but that
  // name does not exist in the Account entity — verified null in FL/TN/TX on
  // 2026-08-24. Pinning this prevents a silent regression to the unpostable name.
  it('uses the FullyQualifiedName form of the inventory account, not the balance-sheet form', () => {
    expect(INVENTORY_ACCOUNT).toBe('Inventory Asset');
    expect(INVENTORY_ACCOUNT).not.toMatch(/^\d/);
  });

  it('uses the FullyQualifiedName form of the COGS account', () => {
    expect(COGS_ACCOUNT).toBe('Cost of Goods Sold');
    expect(COGS_ACCOUNT).not.toMatch(/^\d/);
  });
});

const clv = (over: Partial<CategoryLedgerValue> & { location: string; qbCategory: string }): CategoryLedgerValue => ({
  endingValue: 0,
  receiptIds: [],
  lotCount: 0,
  ...over,
});

describe('buildCategoryRollForward', () => {
  it('pairs each category with its prior-month beginning', () => {
    const prior = [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 800 })];
    const current = [
      clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000, receiptIds: ['r1', 'r2'], lotCount: 2 }),
    ];
    const rows = buildCategoryRollForward(current, prior);
    expect(rows).toHaveLength(1);
    expect(rows[0].beginning).toBe(800);
    expect(rows[0].ending).toBe(1000);
    expect(rows[0].receiptIds).toEqual(['r1', 'r2']);
    expect(rows[0].lotCount).toBe(2);
  });

  it('treats a category absent last month as beginning at zero', () => {
    const prior = [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 800 })];
    const current = [clv({ location: 'MedRock FL', qbCategory: 'Lab Supplies', endingValue: 50 })];
    const rows = buildCategoryRollForward(current, prior);
    expect(rows.find((r) => r.qbCategory === 'Lab Supplies')?.beginning).toBe(0);
  });

  it('leaves beginning null at the window start (no prior month at all)', () => {
    const current = [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 })];
    const rows = buildCategoryRollForward(current, null);
    expect(rows[0].beginning).toBeNull();
  });

  it('keeps locations separate for the same category name', () => {
    const current = [
      clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 100 }),
      clv({ location: 'MedRock TN', qbCategory: 'Commercial Rx', endingValue: 200 }),
    ];
    const rows = buildCategoryRollForward(current, null);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.location === 'MedRock TN')?.ending).toBe(200);
  });

  it('sorts by descending ending value so the material categories read first', () => {
    const current = [
      clv({ location: 'MedRock FL', qbCategory: 'Lab Supplies', endingValue: 50 }),
      clv({ location: 'MedRock FL', qbCategory: 'Compound Ingredient', endingValue: 9000 }),
    ];
    const rows = buildCategoryRollForward(current, null);
    expect(rows.map((r) => r.qbCategory)).toEqual(['Compound Ingredient', 'Lab Supplies']);
  });
});

describe('buildCategoryJE', () => {
  const accountNums: Record<string, string> = {
    'Inventory Asset': '1220',
    'Inventory Asset:Commercial Rx Inventory': '1220.05',
    'Inventory Asset:Compound Ingredient Inventory': '1220.10',
  };
  const bsAccounts = [
    { name: '1220.05 Commercial Rx Inventory', value: 900 },
    { name: '1220.10 Compound Ingredient Inventory', value: 5000 },
  ];

  it('computes a per-category adjustment against that sub-account balance', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000, lotCount: 3 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(je.lines).toHaveLength(1);
    expect(je.lines[0].inventoryAccount).toBe('Inventory Asset:Commercial Rx Inventory');
    expect(je.lines[0].cogsAccount).toBe('Cost of Goods Sold:Commercial RX');
    expect(je.lines[0].qbBookBalance).toBe(900);
    expect(je.lines[0].adjustment).toBe(100); // 1000 − 900
    expect(je.lines[0].direction).toBe('debit-inventory');
    expect(je.lines[0].mapped).toBe(true);
  });

  it('sums the location total from its category lines', () => {
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 }),
        clv({ location: 'MedRock FL', qbCategory: 'Compound Ingredient', endingValue: 4000 }),
      ],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(je.fifoTarget).toBe(5000);
    expect(je.adjustment).toBe(100 + -1000); // (1000−900) + (4000−5000)
  });

  it('routes an unmapped category to the parent accounts and reports it', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 300 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(je.lines[0].mapped).toBe(false);
    expect(je.lines[0].inventoryAccount).toBe('Inventory Asset');
    expect(je.lines[0].cogsAccount).toBe('Cost of Goods Sold');
    expect(je.unmappedCategories).toEqual(['Uncoded']);
  });

  it('treats a sub-account with no balance-sheet row as a zero book balance, not null', () => {
    // A never-funded sub-account is legitimately $0 — the whole FIFO value is the
    // adjustment. Only a MISSING BALANCE SHEET (bookAvailable=false) is unknown.
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Lab Supplies', endingValue: 700 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(je.lines[0].qbBookBalance).toBe(0);
    expect(je.lines[0].adjustment).toBe(700);
  });

  it('marks every adjustment null when the realm gave no balance sheet', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, [], accountNums, false);
    expect(je.bookAvailable).toBe(false);
    expect(je.lines[0].qbBookBalance).toBeNull();
    expect(je.lines[0].adjustment).toBeNull();
    expect(je.lines[0].direction).toBeNull();
  });

  it('keeps locations separate: a multi-location rows array yields only that location\'s lines', () => {
    // computeClose passes the FULL multi-location categoryRollForward array into
    // buildCategoryJE once per location — this filter is what keeps one location's
    // JE from absorbing every other location's categories.
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 }),
        clv({ location: 'MedRock TN', qbCategory: 'Commercial Rx', endingValue: 2000 }),
        clv({ location: 'MedRock TX', qbCategory: 'Compound Ingredient', endingValue: 300 }),
      ],
      null,
    );
    const tnJe = buildCategoryJE('MedRock TN', rows, bsAccounts, accountNums, true);
    expect(tnJe.lines).toHaveLength(1);
    expect(tnJe.lines.every((l) => l.qbCategory === 'Commercial Rx')).toBe(true);
    expect(tnJe.fifoTarget).toBe(2000);
  });
});

describe('categoryJournalEntryLines', () => {
  const accountNums: Record<string, string> = {
    'Inventory Asset:Commercial Rx Inventory': '1220.05',
    'Inventory Asset:Compound Ingredient Inventory': '1220.10',
  };
  const bsAccounts = [
    { name: '1220.05 Commercial Rx Inventory', value: 900 },
    { name: '1220.10 Compound Ingredient Inventory', value: 5000 },
  ];

  it('emits Dr Inventory / Cr COGS on the category sub-accounts for a positive adjustment', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000, receiptIds: ['r1'] })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLines(je, '2026-03-31');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      account: 'Inventory Asset:Commercial Rx Inventory',
      debit: 100,
      credit: null,
    });
    expect(lines[1]).toMatchObject({
      account: 'Cost of Goods Sold:Commercial RX',
      debit: null,
      credit: 100,
    });
    expect(lines[0].memo).toContain('Commercial Rx');
    expect(lines[0].memo).toContain('2026-03-31');
  });

  it('reverses to Dr COGS / Cr Inventory for a negative adjustment', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Compound Ingredient', endingValue: 4000 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLines(je, '2026-03-31');
    expect(lines[0]).toMatchObject({ account: 'Cost of Goods Sold:Compound Ingredient', debit: 1000 });
    expect(lines[1]).toMatchObject({ account: 'Inventory Asset:Compound Ingredient Inventory', credit: 1000 });
  });

  it('skips categories whose adjustment is exactly zero', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 900 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(categoryJournalEntryLines(je, '2026-03-31')).toEqual([]);
  });

  it('always balances: total debits equal total credits', () => {
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 }),
        clv({ location: 'MedRock FL', qbCategory: 'Compound Ingredient', endingValue: 4000 }),
      ],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLines(je, '2026-03-31');
    const debits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(Math.round(debits * 100)).toBe(Math.round(credits * 100));
  });

  it('flags a residual (unmapped) category in the memo so it is never mistaken for a real category', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 300 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, [], { 'Inventory Asset': '1220' }, true);
    const lines = categoryJournalEntryLines(je, '2026-03-31');
    expect(lines[0].memo).toContain('needs drug coding');
  });

  it('emits nothing when the book balance is unavailable', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, [], accountNums, false);
    expect(categoryJournalEntryLines(je, '2026-03-31')).toEqual([]);
  });

  it('mapped categories carry their own receiptIds on their own sub-accounts', () => {
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000, receiptIds: ['c1', 'c2'] }),
        clv({ location: 'MedRock FL', qbCategory: 'Compound Ingredient', endingValue: 4000, receiptIds: ['i1'] }),
      ],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    const rx = lines.find((l) => l.account === 'Inventory Asset:Commercial Rx Inventory');
    const ing = lines.find((l) => l.account === 'Inventory Asset:Compound Ingredient Inventory');
    expect(rx?.receiptIds).toEqual(['c1', 'c2']);
    expect(ing?.receiptIds).toEqual(['i1']);
    expect(rx?.mapped).toBe(true);
  });

  it('delegates: the plain JeLine form is the sourced form with the extras dropped', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 1000, receiptIds: ['u1'] })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, [], {}, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    const plain = categoryJournalEntryLines(je, '2026-03-31');
    expect(plain).toEqual(lines.map(({ account, debit, credit, memo }) => ({ account, debit, credit, memo })));
  });
});

/**
 * The residual (unmapped) categories all fall back to the SAME parent accounts.
 * Emitting a pair each makes every one of them subtract the whole parent book
 * balance B — `Σfifo − n·B` where the truth is `Σfifo − B`. That is inert only
 * while the parent has no balance-sheet row of its own, and this close's own
 * residual posting is precisely what gives it one. Every case below therefore
 * uses a NON-ZERO parent balance: under the pre-fix per-category behavior they
 * fail (two pairs, and a total of Σfifo − 2B).
 */
describe('categoryJournalEntryLines — aggregated residual', () => {
  const accountNums: Record<string, string> = {
    'Inventory Asset': '1220',
    'Inventory Asset:Commercial Rx Inventory': '1220.05',
  };
  // The parent now carries a real balance — what a previous residual post creates.
  const PARENT_BALANCE = 400;
  const bsAccounts = [
    { name: '1220 Inventory Asset', value: PARENT_BALANCE },
    { name: '1220.05 Commercial Rx Inventory', value: 900 },
  ];
  const twoResiduals = () =>
    buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 1000, receiptIds: ['u1', 'u2'], lotCount: 2 }),
        clv({ location: 'MedRock FL', qbCategory: 'Opening Balance', endingValue: 500, receiptIds: ['ob1'], lotCount: 1 }),
      ],
      null,
    );

  it('emits exactly ONE inventory line and ONE COGS line for two unmapped categories', () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    expect(lines).toHaveLength(2); // one pair, not two
    expect(lines.filter((l) => l.account === INVENTORY_ACCOUNT)).toHaveLength(1);
    expect(lines.filter((l) => l.account === COGS_ACCOUNT)).toHaveLength(1);
  });

  it('subtracts the parent balance ONCE: (fifo_U + fifo_OB) − B, never − 2B', () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    const expected = 1000 + 500 - PARENT_BALANCE; // 1100
    const doubleSubtracted = 1000 + 500 - 2 * PARENT_BALANCE; // 700 — the bug
    expect(expected).not.toBe(doubleSubtracted); // the fixture actually discriminates
    const dr = lines.find((l) => l.debit !== null);
    expect(dr?.account).toBe(INVENTORY_ACCOUNT);
    expect(dr?.debit).toBe(expected);
    expect(je.residualBookBalance).toBe(PARENT_BALANCE);
  });

  it("the location total equals what the entry posts (Σfifo − B), so the card's totals row ties", () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    expect(je.fifoTarget).toBe(1500);
    expect(je.adjustment).toBe(1100); // 1500 − 400, NOT 1500 − 800
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    const net = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    expect(Math.abs(net)).toBe(0); // balanced
    const drInventory = lines.find((l) => l.account === INVENTORY_ACCOUNT && l.debit !== null);
    expect(drInventory?.debit).toBe(je.adjustment);
  });

  it("unions the residual categories' receiptIds onto the one line", () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    for (const l of lines) expect(l.receiptIds).toEqual(['u1', 'u2', 'ob1']);
  });

  it('names every category it covers, sorted, and still flags it as needing drug coding', () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    expect(lines[0].qbCategory).toBe('Opening Balance + Uncoded');
    expect(lines[0].mapped).toBe(false);
    expect(lines[0].memo).toContain('Opening Balance + Uncoded');
    expect(lines[0].memo).toContain('needs drug coding');
  });

  it('leaves mapped categories on their own sub-accounts, one pair each, untouched', () => {
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Commercial Rx', endingValue: 1000 }),
        clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 800 }),
        clv({ location: 'MedRock FL', qbCategory: 'Opening Balance', endingValue: 500 }),
      ],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    const rx = lines.filter((l) => l.account === 'Inventory Asset:Commercial Rx Inventory');
    expect(rx).toHaveLength(1);
    expect(rx[0].debit).toBe(100); // 1000 − 900, its own sub-account balance
    expect(rx[0].qbCategory).toBe('Commercial Rx');
    // …and one aggregated residual pair alongside it: (800 + 500) − 400.
    const residualDr = lines.find((l) => l.account === INVENTORY_ACCOUNT && l.debit !== null);
    expect(residualDr?.debit).toBe(900);
    expect(lines).toHaveLength(4);
  });

  it('skips the residual pair entirely when the combined adjustment nets to zero', () => {
    // TX 2026-03 in miniature: residual FIFO exactly equals the parent balance.
    const rows = buildCategoryRollForward(
      [
        clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 400 }),
        clv({ location: 'MedRock FL', qbCategory: 'Opening Balance', endingValue: 0 }),
      ],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    expect(categoryJournalEntryLinesWithSources(je, '2026-03-31')).toEqual([]);
  });

  it('reverses the aggregated pair when the residual FIFO is below the parent balance', () => {
    const rows = buildCategoryRollForward(
      [clv({ location: 'MedRock FL', qbCategory: 'Uncoded', endingValue: 150 })],
      null,
    );
    const je = buildCategoryJE('MedRock FL', rows, bsAccounts, accountNums, true);
    const lines = categoryJournalEntryLinesWithSources(je, '2026-03-31');
    expect(lines[0]).toMatchObject({ account: COGS_ACCOUNT, debit: 250 }); // 400 − 150
    expect(lines[1]).toMatchObject({ account: INVENTORY_ACCOUNT, credit: 250 });
  });

  it('claims the parent balance on exactly one comparison row so the rows foot to the pair', () => {
    const je = buildCategoryJE('MedRock FL', twoResiduals(), bsAccounts, accountNums, true);
    const residualRows = je.lines.filter((l) => !l.mapped);
    expect(residualRows.map((l) => l.qbBookBalance)).toEqual([PARENT_BALANCE, 0]);
    const footed = residualRows.reduce((s, l) => s + (l.adjustment ?? 0), 0);
    expect(footed).toBe(1100);
  });
});

describe('sumCents — the point-in-time page and the close must state one number', () => {
  // The real 2026-03 Tennessee category values. Added in the order the close
  // renders them, this float-sums to a hair under the true total and rounds DOWN
  // to ...19; the point-in-time page groups the same cells in a different order
  // and rounded UP to ...20. Two screens, same lots, one cent apart.
  const TN_2026_03 = [1945681.65, 393095.93, 180812.77, 173134.02, 99187.04, 3383.78];

  it('totals a column the way a reader adding the visible rows does', () => {
    expect(sumCents(TN_2026_03)).toBe(2795295.19);
  });

  it('is order-independent, which naive float summation is not', () => {
    const reversed = [...TN_2026_03].reverse();
    const byValue = [...TN_2026_03].sort((a, b) => a - b);
    expect(sumCents(reversed)).toBe(sumCents(TN_2026_03));
    expect(sumCents(byValue)).toBe(sumCents(TN_2026_03));
  });

  it('does not drift on values that are already whole cents', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; this is the guard against
    // that class of error showing up in a total shown to an accountant.
    expect(sumCents([0.1, 0.2])).toBe(0.3);
    expect(sumCents([])).toBe(0);
  });

  it('rounds each figure before adding, matching what each row displays', () => {
    // Two rows that each display as $0.01 must total $0.02, not the $0.03 a
    // sum-then-round would produce from their raw values.
    expect(sumCents([0.014, 0.014])).toBe(0.02);
  });
});

describe('wasteShrinkPostingLines — the dedicated 5000.55 line (DS sec 17.4 / 23.1)', () => {
  it('posts waste and shrink as separate debits to WASTE_ACCOUNT against one inventory credit', () => {
    const lines = wasteShrinkPostingLines('Inventory Asset', 3673.4, 62972.6, '2026-03-31');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ account: WASTE_ACCOUNT, debit: 3673.4, credit: null });
    expect(lines[0]?.memo).toContain('Documented drug disposal');
    expect(lines[1]).toMatchObject({ account: WASTE_ACCOUNT, debit: 62972.6, credit: null });
    expect(lines[1]?.memo).toContain('count residual');
    expect(lines[2]).toMatchObject({ account: 'Inventory Asset', debit: null, credit: 66646 });
    // Balanced: debits equal the single credit.
    expect(sumCents(lines.filter((l) => l.debit !== null).map((l) => l.debit ?? 0))).toBe(66646);
  });

  it('omits a zero component and returns [] when both are zero', () => {
    const wasteOnly = wasteShrinkPostingLines('Inventory Asset', 100, 0, '2026-04-30');
    expect(wasteOnly).toHaveLength(2);
    expect(wasteOnly[0]?.memo).toContain('Documented drug disposal');
    const shrinkOnly = wasteShrinkPostingLines('Inventory Asset', 0, 250.5, '2026-04-30');
    expect(shrinkOnly).toHaveLength(2);
    expect(shrinkOnly[0]?.memo).toContain('count residual');
    expect(wasteShrinkPostingLines('Inventory Asset', 0, 0, '2026-04-30')).toEqual([]);
  });

  it('throws on a negative input — the clamp lives upstream and a negative here is a defect', () => {
    expect(() => wasteShrinkPostingLines('Inventory Asset', -1, 0, '2026-05-31')).toThrow(/non-negative/);
    expect(() => wasteShrinkPostingLines('Inventory Asset', 0, -0.01, '2026-05-31')).toThrow(/non-negative/);
  });

  it('never posts waste/shrink to a usage-COGS account', () => {
    const lines = wasteShrinkPostingLines('Inventory Asset:Compound Ingredient Inventory', 10, 20, '2026-06-30');
    for (const l of lines.filter((x) => x.debit !== null)) {
      expect(l.account).toBe(WASTE_ACCOUNT);
      expect(l.account).not.toBe(COGS_ACCOUNT);
    }
  });
});
