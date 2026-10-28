import { describe, it, expect, vi, beforeEach } from 'vitest';

interface UsageRowFixture {
  as_of_month: string;
  location: string;
  device: string;
  sku: string;
  fills: number;
  units: string;
  confidence: string;
  disposition: 'depleted';
}

const state: { usage: UsageRowFixture[] | Error; relievedThrough: string | null } = { usage: [], relievedThrough: null };

const query = vi.fn(async (sql: string, params: readonly string[]) => {
  if (sql.includes('inventory.device_usage_monthly')) {
    if (state.usage instanceof Error) throw state.usage;
    const [from, through] = params;
    return { rows: state.usage.filter((r) => r.as_of_month >= from && r.as_of_month <= through) };
  }
  if (sql.includes('payroll_journal_headers')) {
    return { rows: [{ through: state.relievedThrough === null ? null : `${state.relievedThrough}-31` }] };
  }
  throw new Error(`unexpected query: ${sql}`);
});

vi.mock('@/lib/rds', () => ({ getRdsPool: () => ({ query }) }));

import { deviceCostContributionFor } from './device-cost-server';
import { fifoCategoryContribution } from './close-server';
import { assemblePool } from './je-pool';
import { PACKAGING_CATEGORY } from './device-cost-je';
import { accountsForCategory } from './category-accounts';
import type { CategoryJE } from '@/types/inventory';

const row = (qbCategory: string, adjustment: number): CategoryJE['lines'][number] => ({
  qbCategory,
  inventoryAccount: accountsForCategory(qbCategory).inventory,
  cogsAccount: accountsForCategory(qbCategory).cogs,
  mapped: true,
  fifoTarget: 0,
  qbBookBalance: 0,
  adjustment,
  direction: adjustment === 0 ? 'none' : adjustment > 0 ? 'debit-inventory' : 'credit-inventory',
  receiptIds: [],
  lotCount: 1,
});

const je = (location: string, lines: CategoryJE['lines']): CategoryJE => ({
  location,
  lines,
  fifoTarget: 0,
  adjustment: lines.reduce((s, l) => s + (l.adjustment ?? 0), 0),
  bookAvailable: true,
  unmappedCategories: [],
  residualBookBalance: 0,
});

/** FL and TN: the ledger carries packaging, so FIFO already relieves 1220.15 (here: book 1,445.20 above FIFO this month). */
const FL = je('MedRock Florida', [row('Compound Ingredient', -763.02), row(PACKAGING_CATEGORY, -1445.2)]);
/** TN with a packaging row that happens to tie this month — still FIFO's, still not a device-cost entity. */
const TN_TIED = je('MedRock Tennessee', [row('Compound Ingredient', 100), row(PACKAGING_CATEGORY, 0)]);
/** TX: no packaging rows in the ledger at all. */
const TX = je('MedRock Texas', [row('Compound Ingredient', 0), row('Commercial Rx', 0)]);

const usage = (location: string, month: string, units: number): UsageRowFixture => ({
  as_of_month: month,
  location,
  device: 'Rosacea Pump (Frosted)',
  sku: '30g',
  fills: units,
  units: String(units),
  confidence: 'high',
  disposition: 'depleted',
});

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

beforeEach(() => {
  query.mockClear();
  state.relievedThrough = null;
  state.usage = MONTHS.flatMap((m) => [
    usage('MedRock Texas', m, 100),
    usage('MedRock Florida', m, 5000),
    usage('MedRock Tennessee', m, 5000),
  ]);
});

describe('device standard cost joins the pool ONLY where FIFO emits no 1220.15 line', () => {
  it('FL: FIFO carries packaging, so no device contributor and no usage is even read', async () => {
    expect(await deviceCostContributionFor('MedRock FL', FL, '2026-05')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('TN: a packaging row that ties this month still counts as FIFO relieving it', async () => {
    expect(await deviceCostContributionFor('MedRock TN', TN_TIED, '2026-05')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('TX: joins, and the first entry in May catches up Jan to May (500 units x 2.00 = 1,000)', async () => {
    const c = await deviceCostContributionFor('MedRock TX', TX, '2026-05');
    expect(c).not.toBeNull();
    expect(c?.available).toBe(true);
    expect(c?.lines.map((l) => [l.postingType, l.accountName, l.amount])).toEqual([
      ['Debit', 'Cost of Goods Sold:Compound Packaging', 1000],
      ['Credit', 'Inventory Asset:Compound Packaging Inventory', 1000],
    ]);
    expect(c?.lines[0].memo).toContain('CATCH-UP covering 2026-01 through 2026-05');
    expect(c?.lines[0].sourceRowKeys).toEqual(['device|Rosacea Pump (Frosted)|30g']);
  });

  it('TX: a second correction in the same month adds nothing — May is already relieved', async () => {
    state.relievedThrough = '2026-05';
    const c = await deviceCostContributionFor('MedRock TX', TX, '2026-05');
    expect(c?.available).toBe(true);
    expect(c?.lines).toHaveLength(0);
  });

  it('TX: June carries only June once May has posted', async () => {
    state.relievedThrough = '2026-05';
    const c = await deviceCostContributionFor('MedRock TX', TX, '2026-06');
    expect(c?.lines[0].amount).toBe(200);
    expect(c?.lines[0].memo).not.toContain('CATCH-UP');
  });

  it('TX: an unreadable usage table blocks the pool instead of posting a packaging-shaped hole', async () => {
    state.usage = new Error('relation does not exist');
    const c = await deviceCostContributionFor('MedRock TX', TX, '2026-05');
    expect(c?.available).toBe(false);
    expect(assemblePool(c === null ? [] : [c]).unavailable).toEqual(['device-standard-cost']);
  });
});

describe('assembled pool: 1220.15 is relieved once, by exactly one mechanism', () => {
  const PACKAGING_ASSET = 'Inventory Asset:Compound Packaging Inventory';
  const creditsToPackagingAsset = (lines: ReadonlyArray<{ postingType: string; accountName: string; amount: number }>): number =>
    lines
      .filter((l) => l.postingType === 'Credit' && l.accountName === PACKAGING_ASSET)
      .reduce((s, l) => s + l.amount, 0);

  it('FL: only the FIFO packaging line — the 5,000 units/month of device cost in the table are NOT added on top', async () => {
    const device = await deviceCostContributionFor('MedRock FL', FL, '2026-05');
    const pool = assemblePool([fifoCategoryContribution(FL, '2026-05-31'), ...(device === null ? [] : [device])]);
    expect(pool.subtotals.map((s) => s.source)).toEqual(['fifo-category']);
    expect(creditsToPackagingAsset(pool.lines)).toBe(1445.2);
  });

  it('TX: only the device line (TX FIFO has none)', async () => {
    const device = await deviceCostContributionFor('MedRock TX', TX, '2026-05');
    const pool = assemblePool([fifoCategoryContribution(TX, '2026-05-31'), ...(device === null ? [] : [device])]);
    expect(pool.subtotals.map((s) => s.source)).toEqual(['fifo-category', 'device-standard-cost']);
    expect(creditsToPackagingAsset(pool.lines)).toBe(1000);
    expect(pool.variance).toBe(0);
  });
});
