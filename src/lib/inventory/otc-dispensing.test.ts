import { describe, it, expect } from 'vitest';
import {
  OTC_SCHEDULE_CODE,
  OTC_COGS_ACCOUNT,
  OTC_INVENTORY_ACCOUNT,
  EXCLUDED_OTC_PRODUCT_IDS,
  LF_BOM_LOCATION_KEY,
  LF_DISPENSING_LOCATION_SQL,
  otcShare,
  buildOtcCogsLines,
  otcCogsContribution,
  type OtcProductMonth,
} from './otc-dispensing';
import { assemblePool } from './je-pool';

function cell(over: Partial<OtcProductMonth> = {}): OtcProductMonth {
  return {
    month: '2026-08',
    location: 'MedRock Tennessee',
    productId: '300987895',
    productName: 'CeraVe Moisturizing Lotion',
    sourceCategory: 'Compound Ingredient',
    otcQty: 100,
    totalUsageQty: 100,
    fifoConsumedValue: 200,
    ...over,
  };
}

describe('the constants that decide what OTC is', () => {
  // Pinned, not asserted for coverage: 'O' is the only non-prescription Schedule
  // LifeFile emits, and widening it to 'Generic' or 'Commercial' would silently
  // sweep the entire commercial Rx book into 5000.35.
  it("identifies OTC by LifeFile Schedule 'O'", () => {
    expect(OTC_SCHEDULE_CODE).toBe('O');
  });

  // A bare account number resolves to NOTHING in buildJePayload and makes the
  // pooled entry unpostable — the 2026-08-24 close-JE failure.
  it('names accounts by QuickBooks FullyQualifiedName, never by number', () => {
    expect(OTC_COGS_ACCOUNT).toBe('Cost of Goods Sold:OTC Items');
    expect(OTC_INVENTORY_ACCOUNT).toBe('Inventory Asset:OTC Items Inventory');
    for (const name of [OTC_COGS_ACCOUNT, OTC_INVENTORY_ACCOUNT]) {
      expect(name).not.toMatch(/^\d/);
    }
  });

  it('excludes the LifeFile TEST product by id', () => {
    expect(EXCLUDED_OTC_PRODUCT_IDS).toContain('305521403');
  });

  // Reading only 'Location' loses every fill from mid-August 2026 onward.
  it('reads the location under both the plain and the BOM-prefixed key', () => {
    expect(LF_BOM_LOCATION_KEY.charCodeAt(0)).toBe(0xfeff);
    expect(LF_BOM_LOCATION_KEY).toBe('﻿"Location"');
    expect(LF_DISPENSING_LOCATION_SQL).toContain("row_data->>'Location'");
    expect(LF_DISPENSING_LOCATION_SQL).toContain(LF_BOM_LOCATION_KEY);
    expect(LF_DISPENSING_LOCATION_SQL.startsWith('COALESCE(')).toBe(true);
  });
});

describe('otcShare', () => {
  it('is the OTC quantity over total usage', () => {
    expect(otcShare(cell({ otcQty: 25, totalUsageQty: 100 }))).toBe(0.25);
  });

  it('is 1 when nothing but OTC drew on the product', () => {
    // The combs' normal state: dispensed, never used as an ingredient.
    expect(otcShare(cell({ otcQty: 40, totalUsageQty: 0 }))).toBe(1);
  });

  it('is 0 when the cell dispensed no OTC', () => {
    expect(otcShare(cell({ otcQty: 0, totalUsageQty: 500 }))).toBe(0);
  });

  it('CLAMPS above 1 rather than over-attributing cost', () => {
    // The dispensing feed can run a day ahead of the usage feed. Without the
    // clamp this cell would move $240 of a $200 consumption onto 5000.35.
    expect(otcShare(cell({ otcQty: 120, totalUsageQty: 100 }))).toBe(1);
  });
});

describe('buildOtcCogsLines', () => {
  it('debits OTC COGS and credits the account the close already charged', () => {
    const built = buildOtcCogsLines([cell({ fifoConsumedValue: 200, otcQty: 100, totalUsageQty: 100 })], '2026-08');
    expect(built.otcCogs).toBe(200);
    expect(built.lines).toHaveLength(2);
    expect(built.lines[0]).toMatchObject({
      postingType: 'Debit',
      amount: 200,
      accountName: OTC_COGS_ACCOUNT,
    });
    expect(built.lines[1]).toMatchObject({
      postingType: 'Credit',
      amount: 200,
      accountName: 'Cost of Goods Sold:Compound Ingredient',
    });
  });

  it('never touches 1220.25 — the stock it relieves was never debited there', () => {
    const built = buildOtcCogsLines(
      [
        cell({ sourceCategory: 'Commercial Rx' }),
        cell({ sourceCategory: 'Compound Ingredient' }),
      ],
      '2026-08',
    );
    for (const l of built.lines) {
      expect(l.accountName).not.toContain('Inventory Asset');
      expect(l.accountName).not.toBe(OTC_INVENTORY_ACCOUNT);
    }
  });

  it('balances: the single debit equals the sum of the split credits', () => {
    // Cent-level: three categories whose shares each round, as the live
    // 2026-07 Texas cell does (28.72 + 1.25 = 29.97).
    const built = buildOtcCogsLines(
      [
        cell({ sourceCategory: 'Commercial Rx', fifoConsumedValue: 1.253, otcQty: 1, totalUsageQty: 1 }),
        cell({ sourceCategory: 'Compound Ingredient', fifoConsumedValue: 28.717, otcQty: 1, totalUsageQty: 1 }),
      ],
      '2026-07',
    );
    const debits = built.lines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0);
    const credits = built.lines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0);
    expect(debits).toBe(credits);
    expect(built.otcCogs).toBe(29.97);
  });

  it('splits one product between OTC and compounding by its dispensed share', () => {
    // CeraVe: dispensed whole AND stirred into creams in the same month.
    const built = buildOtcCogsLines(
      [cell({ otcQty: 900, totalUsageQty: 1000, fifoConsumedValue: 1000 })],
      '2026-08',
    );
    expect(built.otcCogs).toBe(900);
  });

  it('drops the excluded TEST product without dropping the month', () => {
    const built = buildOtcCogsLines(
      [
        cell({ productId: '305521403', productName: 'TEST COMMERCIAL LF 01', fifoConsumedValue: 999 }),
        cell({ fifoConsumedValue: 50 }),
      ],
      '2026-08',
    );
    expect(built.excludedCells).toBe(1);
    expect(built.otcCogs).toBe(50);
  });

  it('emits nothing at all for a month with no OTC value', () => {
    // A shelf of $0.00 entries is noise the accountant reads past every month.
    const built = buildOtcCogsLines([cell({ fifoConsumedValue: 0 })], '2026-02');
    expect(built.lines).toEqual([]);
    expect(built.otcCogs).toBe(0);
  });

  it('warns, and still posts, when a category has no QuickBooks pair', () => {
    const built = buildOtcCogsLines([cell({ sourceCategory: 'Uncoded', fifoConsumedValue: 12 })], '2026-08');
    expect(built.lines[1]?.accountName).toBe('Cost of Goods Sold');
    expect(built.warnings.join(' ')).toContain('Uncoded');
  });

  it('warns when the dispensing feed runs ahead of the usage feed', () => {
    const built = buildOtcCogsLines([cell({ otcQty: 120, totalUsageQty: 100 })], '2026-09');
    expect(built.warnings.join(' ')).toContain('capped at 100%');
    // capped, so still exactly the ledger's consumption — never more
    expect(built.otcCogs).toBe(200);
  });

  it('carries the contributing LifeFile product ids on the credit line', () => {
    const built = buildOtcCogsLines(
      [
        cell({ sourceCategory: 'Commercial Rx', productId: '303254223' }),
        cell({ sourceCategory: 'Commercial Rx', productId: '300987942' }),
      ],
      '2026-08',
    );
    expect(built.lines[1]?.sourceRowKeys).toEqual(['300987942', '303254223']);
  });
});

describe('otcCogsContribution', () => {
  it('assembles into a balanced pool alongside the FIFO adjustment', () => {
    const contribution = otcCogsContribution([cell({ fifoConsumedValue: 832.32 })], '2026-08');
    const pool = assemblePool([contribution]);
    expect(pool.variance).toBe(0);
    expect(pool.postable).toBe(true);
    expect(pool.subtotals[0]).toMatchObject({ source: 'otc-items', debits: 832.32, credits: 832.32 });
  });

  it('is available with zero lines when the month simply had no OTC value', () => {
    // "ran and found nothing" must not read as "never ran" — je-pool.ts's rule.
    const pool = assemblePool([otcCogsContribution([], '2026-02')]);
    expect(pool.unavailable).toEqual([]);
    expect(pool.subtotals[0]).toMatchObject({ source: 'otc-items', lineCount: 0 });
  });

  it('blocks the pool when the read itself failed', () => {
    const pool = assemblePool([otcCogsContribution([cell()], '2026-08', false)]);
    expect(pool.unavailable).toEqual(['otc-items']);
    expect(pool.postable).toBe(false);
    expect(pool.lines).toEqual([]);
  });
});
