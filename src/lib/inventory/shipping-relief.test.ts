import { describe, it, expect } from 'vitest';
import {
  buildShippingReliefContribution,
  shippingTarget,
  ratioOf,
  SHIPPING_RATIOS,
  SHIPPING_RELIEF_ASSET_ACCOUNT,
  SHIPPING_RELIEF_EXPENSE_ACCOUNT,
  SHIPPING_RELIEF_SOURCE_KEY,
  type ShippingReliefInput,
} from './shipping-relief';
import { buildShippingReliefDetailSheet, parseShippingReliefSnapshot } from './je-detail-shipping-pool';
import { findManualReliefs, sumPnlRows } from './shipping-relief-server';
import type { ShippingLocation } from './shipping-packaging-accrual';

/**
 * Barbara's posted `Ship Pkg Adj 26.0x` entries, 2026-09-18: postage (5000.40) and the target
 * she wrote in each memo. The code must land on every one of these to the cent.
 */
const BARBARA: ReadonlyArray<readonly [ShippingLocation, string, number, number]> = [
  ['MedRock FL', '2026-03', 85_839.56, 4_222.6],
  ['MedRock FL', '2026-04', 78_782.1, 3_875.43],
  ['MedRock FL', '2026-05', 78_121.79, 3_842.95],
  ['MedRock FL', '2026-06', 78_877.37, 3_880.12],
  ['MedRock FL', '2026-07', 81_710.99, 4_019.51],
  ['MedRock FL', '2026-08', 87_740.97, 4_316.13],
  ['MedRock FL', 'Jan+Feb', 106_738.69, 5_250.66],
  ['MedRock TN', '2026-03', 105_343.87, 4_983.79],
  ['MedRock TN', '2026-04', 96_535.57, 4_567.07],
  ['MedRock TN', '2026-05', 105_332.16, 4_983.23],
  ['MedRock TN', '2026-06', 105_771.46, 5_004.02],
  ['MedRock TN', '2026-07', 116_509.96, 5_512.05],
  ['MedRock TN', '2026-08', 109_324.2, 5_172.1],
  ['MedRock TN', 'Jan+Feb', 128_724.96, 6_089.94],
  ['MedRock TX', '2026-03', 8_260.35, 398.24],
  ['MedRock TX', '2026-04', 10_309.01, 497.01],
  ['MedRock TX', '2026-05', 10_134.55, 488.6],
  ['MedRock TX', '2026-06', 14_580.96, 702.96],
  ['MedRock TX', '2026-07', 17_205.48, 829.5],
  ['MedRock TX', '2026-08', 17_180.98, 828.31],
];

const base: ShippingReliefInput = {
  location: 'MedRock FL',
  month: '2026-09',
  monthEnded: true,
  available: true,
  postage: 90_000,
  packagingCarried: 0,
  assetBalance: 53_633.35,
  manualReliefs: [],
};

describe('shippingTarget — reproduces Barbara to the cent', () => {
  it.each(BARBARA)('%s %s: postage %d → target %d', (location, _month, postage, target) => {
    expect(shippingTarget(postage, SHIPPING_RATIOS[location])).toBe(target);
  });

  it('prints the same percentages her memos do', () => {
    expect((ratioOf(SHIPPING_RATIOS['MedRock FL']) * 100).toFixed(4)).toBe('4.9192');
    expect((ratioOf(SHIPPING_RATIOS['MedRock TN']) * 100).toFixed(4)).toBe('4.7310');
    expect((ratioOf(SHIPPING_RATIOS['MedRock TX']) * 100).toFixed(4)).toBe('4.8211');
  });

  it('needs the unrounded ratio — the printed 4.9192% misses April by 2 cents', () => {
    expect(Math.round(78_782.1 * 0.049192 * 100) / 100).toBe(3_875.45);
    expect(shippingTarget(78_782.1, SHIPPING_RATIOS['MedRock FL'])).toBe(3_875.43);
  });
});

describe('buildShippingReliefContribution', () => {
  it('books her relief: target less what 5000.20 already carries (TX May: 488.60 − 428.00)', () => {
    const c = buildShippingReliefContribution(
      { ...base, location: 'MedRock TX', month: '2026-05', postage: 10_134.55, packagingCarried: 428, assetBalance: 6_860.11 },
      '2026-09-18',
    );
    expect(c.target).toBe(488.6);
    expect(c.relief).toBe(60.6);
    expect(c.lines).toHaveLength(2);
    const [dr, cr] = c.lines;
    expect(dr).toMatchObject({ postingType: 'Debit', amount: 60.6, accountName: SHIPPING_RELIEF_EXPENSE_ACCOUNT });
    expect(cr).toMatchObject({ postingType: 'Credit', amount: 60.6, accountName: SHIPPING_RELIEF_ASSET_ACCOUNT });
    expect(dr.sourceRowKeys).toEqual([SHIPPING_RELIEF_SOURCE_KEY]);
    expect(c.warnings.some((w) => w.includes('borrowed'))).toBe(true);
  });

  it('uses QuickBooks FullyQualifiedNames, never bare account numbers', () => {
    expect(SHIPPING_RELIEF_EXPENSE_ACCOUNT).toBe('Cost of Goods Sold:Final Packaging Materials');
    expect(SHIPPING_RELIEF_ASSET_ACCOUNT).toBe('Inventory Asset:Shipping Packaging Material Inventory');
  });

  it('books NOTHING for a month relieved by hand — FL March would otherwise re-book the Jan–Feb true-up', () => {
    // March 5000.20 = 3,873.57 relief − 694.67 true-up + 349.03 direct = 3,527.93; target 4,222.60.
    const c = buildShippingReliefContribution(
      {
        ...base,
        month: '2026-03',
        postage: 85_839.56,
        packagingCarried: 3_527.93,
        manualReliefs: [{ docNumber: 'FL Ship Pkg Adj 26.03', txnDate: '2026-03-31', amount: 3_873.57 }],
      },
      '2026-09-18',
    );
    expect(c.lines).toHaveLength(0);
    expect(c.available).toBe(true);
    expect(c.snapshot?.rawRelief).toBe(694.67);
    expect(c.snapshot?.relief).toBe(0);
    expect(c.warnings.join(' ')).toContain('FL Ship Pkg Adj 26.03');
  });

  it('is zero once 5000.20 already sits at target — a correction after the parent posted adds nothing', () => {
    const c = buildShippingReliefContribution({ ...base, postage: 87_740.97, packagingCarried: 4_316.13 }, '2026-09-18');
    expect(c.lines).toHaveLength(0);
    expect(c.relief).toBe(0);
    expect(c.warnings).toHaveLength(0);
  });

  it('floors a negative relief at zero and flags it rather than moving expense back to inventory', () => {
    const c = buildShippingReliefContribution({ ...base, postage: 10_000, packagingCarried: 900 }, '2026-09-18');
    expect(c.lines).toHaveLength(0);
    expect(c.snapshot?.rawRelief).toBeLessThan(0);
    expect(c.warnings.join(' ')).toContain('above the');
  });

  it('flags, but still books, a relief larger than the asset', () => {
    const c = buildShippingReliefContribution({ ...base, postage: 90_000, assetBalance: 100 }, '2026-09-18');
    expect(c.lines).toHaveLength(2);
    expect(c.warnings.join(' ')).toContain('go negative');
  });

  it('does not relieve a month still running', () => {
    const c = buildShippingReliefContribution({ ...base, monthEnded: false }, '2026-09-18');
    expect(c.available).toBe(true);
    expect(c.lines).toHaveLength(0);
    expect(c.snapshot).toBeNull();
  });

  it('blocks the pool when QuickBooks could not be read', () => {
    const c = buildShippingReliefContribution({ ...base, available: false }, '2026-09-18');
    expect(c.available).toBe(false);
    expect(c.lines).toHaveLength(0);
  });
});

describe('findManualReliefs', () => {
  const asset = new Set(['266']);
  const packaging = new Set(['501']);
  const je = (id: string, doc: string, lines: Array<['Debit' | 'Credit', string, number]>) => ({
    Id: id,
    DocNumber: doc,
    TxnDate: '2026-08-31',
    Line: lines.map(([p, a, amt]) => ({ Amount: amt, JournalEntryLineDetail: { PostingType: p, AccountRef: { value: a } } })),
  });

  it('finds her relief, ignores inter-entity allocations and our own close entry', () => {
    const found = findManualReliefs(
      [
        je('1', 'FL Ship Pkg Adj 26.08', [['Debit', '501', 4_316.13], ['Credit', '266', 4_316.13]]),
        je('2', '', [['Credit', '266', 350], ['Debit', '1210', 350]]),
        je('3', 'FL Inv Adj 2026.08', [['Debit', '501', 10], ['Credit', '266', 10]]),
        je('4', 'FL Inv Adj 2026.08-2', [['Debit', '501', 5], ['Credit', '266', 5]]),
      ],
      asset,
      packaging,
      'FL Inv Adj 2026.08',
    );
    expect(found).toEqual([{ docNumber: 'FL Ship Pkg Adj 26.08', txnDate: '2026-08-31', amount: 4_316.13 }]);
  });
});

describe('sumPnlRows', () => {
  it('reads leaf rows by id and a parent section by its summary, without double counting', () => {
    const rows = [
      {
        Header: { ColData: [{ value: 'Cost of Goods Sold', id: '400' }] },
        Rows: {
          Row: [
            { ColData: [{ value: '5000.20 Final Packaging Materials', id: '501' }, { value: '4316.13' }] },
            {
              Header: { ColData: [{ value: '5000.40 Postage', id: '540' }] },
              Rows: { Row: [{ ColData: [{ value: 'child', id: '541' }, { value: '100.00' }] }] },
              Summary: { ColData: [{ value: 'Total 5000.40' }, { value: '87740.97' }] },
            },
          ],
        },
        Summary: { ColData: [{ value: 'Total' }, { value: '999999' }] },
      },
    ];
    expect(sumPnlRows(rows, new Set(['501']))).toBe(4316.13);
    expect(sumPnlRows(rows, new Set(['540', '541']))).toBe(87740.97);
  });
});

describe('shipping basis sheet', () => {
  const c = buildShippingReliefContribution({ ...base, postage: 90_000, packagingCarried: 100 }, '2026-10-05');

  it('emits the sheet when the stored lines tie to the retained relief', () => {
    const snapshot = parseShippingReliefSnapshot(c.snapshot);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    const sheets = buildShippingReliefDetailSheet(c.lines, snapshot);
    expect(sheets).toHaveLength(1);
    const total = sheets[0].rows.find((r) => r.step === 'TOTAL');
    expect(total?.debit).toBe(c.relief);
  });

  it('emits nothing when the lines no longer match the basis', () => {
    const snapshot = parseShippingReliefSnapshot(c.snapshot);
    if (snapshot === null) throw new Error('snapshot');
    const edited = c.lines.map((l) => ({ ...l, amount: l.amount + 1 }));
    expect(buildShippingReliefDetailSheet(edited, snapshot)).toEqual([]);
  });

  it('rejects a snapshot of another kind', () => {
    expect(parseShippingReliefSnapshot({ kind: 'lab-supplies-pool' })).toBeNull();
  });
});
