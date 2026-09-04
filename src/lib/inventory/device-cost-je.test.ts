import { describe, it, expect } from 'vitest';
import {
  monthsCoveredBy,
  valueDeviceUsage,
  deviceCostMemo,
  deviceCostContribution,
  DEVICE_COST_TRUEUP_MONTH,
  type DeviceUsageRow,
} from './device-cost-je';

const usage = (over: Partial<DeviceUsageRow> = {}): DeviceUsageRow => ({
  asOfMonth: '2026-04',
  location: 'MedRock Tennessee',
  device: 'Rosacea Pump',
  sku: '30g',
  fills: 100,
  units: 100,
  confidence: 'high',
  disposition: 'depleted',
  ...over,
});

describe('which months a close month is responsible for', () => {
  it('carries only itself in an ordinary month', () => {
    expect(monthsCoveredBy('2026-04')).toEqual(['2026-04']);
    expect(monthsCoveredBy('2026-08')).toEqual(['2026-08']);
  });

  it('carries January and February into the March true-up', () => {
    // Carson, 2026-09-03: "Can't we fill backwards and do a large true-up in
    // March like we planned for inventory".
    expect(monthsCoveredBy(DEVICE_COST_TRUEUP_MONTH)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('reaches back no further than 2026-01, whatever is asked of it', () => {
    // The scope ruling is 2026 forward. 2025 is not restated; it discharges
    // through the same March figure.
    expect(monthsCoveredBy('2025-12')).toEqual([]);
    expect(monthsCoveredBy(DEVICE_COST_TRUEUP_MONTH)[0]).toBe('2026-01');
  });
});

describe('valuing usage', () => {
  it('multiplies units by the standard price', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [usage({ units: 1_000 })]);
    expect(r.total).toBe(2040); // 1,000 x 2.04
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].pricePerUnit).toBe(2.04);
  });

  it('sums the covered months into one figure in the true-up month', () => {
    const r = valueDeviceUsage('MedRock Tennessee', DEVICE_COST_TRUEUP_MONTH, [
      usage({ asOfMonth: '2026-01', units: 100 }),
      usage({ asOfMonth: '2026-02', units: 100 }),
      usage({ asOfMonth: '2026-03', units: 100 }),
      usage({ asOfMonth: '2026-04', units: 999 }), // outside the window
    ]);
    expect(r.total).toBe(612); // 300 x 2.04, April excluded
  });

  it('ignores other entities entirely', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ units: 100 }),
      usage({ units: 500, location: 'MedRock Florida' }),
    ]);
    expect(r.total).toBe(204);
  });

  it('values units that depleted NO lot — that is the whole point', () => {
    // ~54,500 units a year carry disposition 'unpurchased' (Wart Pen, Eye Pad,
    // Nail Brush, the companions). The FIFO close cannot see them at all, which
    // is much of why 1220.15 has never been relieved.
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ device: 'Wart Pen', sku: '', units: 1_000, disposition: 'unpurchased' }),
    ]);
    expect(r.total).toBe(1230);
  });

  it('discloses unpriced units instead of valuing them at zero', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ device: 'Topi-Click', sku: '', units: 300 }),
      usage({ device: 'Syringes', sku: '10mL airless', units: 80 }),
    ]);
    expect(r.total).toBe(0);
    expect(r.unpricedUnits.get('Topi-Click')).toBe(300);
    expect(r.unpricedUnits.get('Syringes')).toBe(80);
    expect(r.lines).toHaveLength(0);
  });

  it('puts the biggest dollars first', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ device: 'Ointment Jar', sku: '2oz', units: 100 }),
      usage({ device: 'Rosacea Pump', sku: '30g', units: 100 }),
    ]);
    expect(r.lines[0].device).toBe('Rosacea Pump');
  });
});

describe('the journal lines', () => {
  it('debits packaging COGS and credits packaging inventory, balanced', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [usage({ units: 1_000 })]);
    expect(c.available).toBe(true);
    expect(c.lines).toHaveLength(2);
    const [dr, cr] = c.lines;
    expect(dr.postingType).toBe('Debit');
    expect(dr.accountName).toBe('Cost of Goods Sold:Compound Packaging');
    expect(cr.postingType).toBe('Credit');
    expect(cr.accountName).toBe('Inventory Asset:Compound Packaging Inventory');
    expect(dr.amount).toBe(cr.amount);
  });

  it('emits no lines at all when nothing was consumed, and stays available', () => {
    // "ran and had nothing to relieve" must not read as "never ran".
    const c = deviceCostContribution('MedRock Texas', '2026-04', []);
    expect(c.lines).toHaveLength(0);
    expect(c.available).toBe(true);
  });

  it('is UNAVAILABLE when usage could not be read, so the pool blocks posting', () => {
    const c = deviceCostContribution('MedRock Texas', '2026-04', null);
    expect(c.available).toBe(false);
    expect(c.lines).toHaveLength(0);
    expect(c.warnings.join(' ')).toContain('could not be read');
  });

  it('says on the entry itself that March is a catch-up', () => {
    // A three-month figure that reads as one month of packaging consumption is
    // exactly the misreading this is here to prevent.
    const c = deviceCostContribution(
      'MedRock Tennessee',
      DEVICE_COST_TRUEUP_MONTH,
      [usage({ asOfMonth: '2026-01', units: 100 })],
    );
    expect(c.lines[0].memo).toContain('CATCH-UP');
    expect(c.warnings.join(' ')).toContain('3-month catch-up');
  });

  it('does not label an ordinary month as a catch-up', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-05', [
      usage({ asOfMonth: '2026-05', units: 100 }),
    ]);
    expect(c.lines[0].memo).not.toContain('CATCH-UP');
    expect(deviceCostMemo(valueDeviceUsage('MedRock Tennessee', '2026-05', []))).toContain('2026-05');
  });

  it('warns loudly about every device it could not price', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [
      usage({ device: 'Topi-Click', sku: '', units: 300 }),
    ]);
    const text = c.warnings.join(' ');
    expect(text).toContain('300 Topi-Click units consumed but NOT valued');
    expect(text).toContain('RETIRED');
  });

  it('always states that it is not driving 1220.15 to a target', () => {
    // Carson, 2026-09-04, on counting packaging on hand: "Not possible to know".
    // So the balance keeps its pre-2026 accumulation and the reviewer is told.
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [usage()]);
    expect(c.warnings.join(' ')).toContain('physical count');
  });

  it('rounds to cents so the two halves cannot disagree', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [
      usage({ device: 'Scar Sheet Pack', sku: '', units: 3 }), // 3 x 0.17 = 0.51
      usage({ device: 'Ointment Jar', sku: '2oz', units: 4 }), // 4 x 0.43 = 1.72
    ]);
    expect(c.lines[0].amount).toBe(2.23);
    expect(c.lines[0].amount).toBe(c.lines[1].amount);
  });
});

describe('eye pads — measured, shown, and deliberately not relieved here', () => {
  // Carson, 2026-09-04: "They are technically compound ingredient since they are
  // part of the formula, but the lifefile system will not pull them down, so
  // we'll need to fold it in as if it was a device."
  //
  // Folded in for visibility. NOT given a packaging credit: eye pads are bought
  // into 1220.10 and have no lot-ledger receipts, so the FIFO close's Compound
  // Ingredient line already sweeps them via target-vs-book. A device line would
  // relieve the same $934.86 twice.
  it('prices and shows the units', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ device: 'Eye Pad Pack', sku: '', units: 1_000 }),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].value).toBe(180); // 1,000 x 0.18
  });

  it('keeps their value OUT of the posted total', () => {
    const r = valueDeviceUsage('MedRock Tennessee', '2026-04', [
      usage({ device: 'Eye Pad Pack', sku: '', units: 1_000 }),
      usage({ device: 'Rosacea Pump', sku: '30g', units: 100 }),
    ]);
    expect(r.total).toBe(204); // the pump only
    expect(r.lines.find((l) => l.device === 'Eye Pad Pack')?.notRelieved).toContain('1220.10');
  });

  it('emits no journal line at all when eye pads are the only usage', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [
      usage({ device: 'Eye Pad Pack', sku: '', units: 1_000 }),
    ]);
    expect(c.lines).toHaveLength(0);
    expect(c.available).toBe(true);
  });

  it('says on the entry why they are shown but not relieved', () => {
    const c = deviceCostContribution('MedRock Tennessee', '2026-04', [
      usage({ device: 'Eye Pad Pack', sku: '', units: 1_000 }),
    ]);
    const text = c.warnings.join(' ');
    expect(text).toContain('shown but NOT relieved');
    expect(text).toContain('twice');
  });
});
