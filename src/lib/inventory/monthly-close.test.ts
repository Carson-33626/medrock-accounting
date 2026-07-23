import { describe, it, expect } from 'vitest';
import {
  buildRollForward,
  buildLocationJE,
  journalEntryLines,
  INVENTORY_ACCOUNT,
  COGS_ACCOUNT,
  type RollbackMonthValue,
} from './monthly-close';

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
