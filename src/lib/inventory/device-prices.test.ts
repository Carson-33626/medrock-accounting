/**
 * The price table is pinned, not merely tested.
 *
 * These numbers multiply straight into a posted journal entry, so the point of
 * this file is that nobody can change one quietly. A price move should break a
 * test and force the person moving it to state the new source — the way
 * `ACCRUAL_PARAMETERS` is pinned for the lab-supplies accrual.
 */
import { describe, it, expect } from 'vitest';
import {
  DEVICE_UNIT_PRICES,
  UNPRICED,
  priceFor,
  unpricedReason,
  type DevicePrice,
} from './device-prices';

const priced = (device: string, sku: string): DevicePrice => {
  const p = priceFor(device, sku);
  if (p === null) throw new Error(`expected a price for ${device} / ${sku}`);
  return p;
};

describe('the price table itself', () => {
  it('has no duplicate (device, sku) pairs — a duplicate would silently shadow', () => {
    const keys = DEVICE_UNIT_PRICES.map((p) => `${p.device}||${p.sku}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prices every unit above zero — a $0.00 unit is an unpriced one wearing a price', () => {
    for (const p of DEVICE_UNIT_PRICES) {
      expect(p.pricePerUnit, `${p.device} ${p.sku}`).toBeGreaterThan(0);
    }
  });

  it('states a source for every price', () => {
    for (const p of DEVICE_UNIT_PRICES) {
      expect(p.provenance.length, `${p.device} ${p.sku}`).toBeGreaterThan(40);
    }
  });

  it('keeps every unit inside the observed packaging band', () => {
    // Measured 2026-09-04 across CPN, Bottlemate, ULINE and U.S. Plastic: no
    // packaging item at any vendor exceeds $2.17/unit, the highest being a ULINE
    // 32 oz jar at $2.15. The $4.20 and $189.64 Tret Pump anchors both sat far
    // outside this band and both turned out to be case prices. A ceiling of $3.00
    // leaves headroom for a genuine premium item while still catching that class
    // of error on the way in.
    for (const p of DEVICE_UNIT_PRICES) {
      expect(p.pricePerUnit, `${p.device} ${p.sku}`).toBeLessThan(3.0);
    }
  });
});

describe("Carson's 2026-09-04 rulings", () => {
  it('prices the Tret Pump off the 2026 Echo jar bills, NOT the assumed 100-count case', () => {
    // The Tret Pump is CPN's Echo airless jar (LifeFile lot 24ECH50CW = "Tret Pump
    // (45g)"). Echo 30 ML -> 20g, Echo 50 ML -> 45g. $1.90 was $189.64 / an ASSUMED
    // case of 100, and the 2022-23 midpoint 2.28 is superseded by 2026 bills.
    expect(priced('Tret Pump', '20g').pricePerUnit).toBe(2.17);
    expect(priced('Tret Pump', '45g').pricePerUnit).toBe(2.14);
    expect(priced('Tret Pump', '20g').provenance).toContain('Echo 30 ML');
    expect(priced('Tret Pump', '45g').provenance).toContain('24ECH50CW');
  });

  it('prices a scar sheet per SQUARE broken off the roll, not per roll', () => {
    // "they are 1.6 x 120 and they break off 4 squares for the 15gm and 8 for the
    // 30gm". $12.83/roll over 75 squares. A per-ROLL price here would be 75x too
    // high against a companion that counts 4 and 8.
    expect(priced('Scar Sheet Pack', '').pricePerUnit).toBe(0.17);
    expect(priced('Scar Sheet Pack', '').pricePerUnit * 75).toBeCloseTo(12.83, 0);
  });

  it('prices a V-Line mask at the case of 25 Carson stated', () => {
    // "V-line mask pack is 25 per case". $38.99 / 25. The listing does not state
    // a pack count, so the 25 is his and the price is only as good as it.
    expect(priced('Neck Wrap Pack', '').pricePerUnit).toBe(1.56);
    expect(priced('Neck Wrap Pack', '').pricePerUnit * 25).toBeCloseTo(38.99, 1);
  });

  it('retires the Topi-Click rather than pricing it', () => {
    // "Topiclick was for hormones that we no longer use so that can be written off."
    expect(priceFor('Topi-Click', '')).toBeNull();
    expect(unpricedReason('Topi-Click')).toContain('RETIRED');
  });
});

describe("the lab's 2026-09-25 packaging reference", () => {
  it('prices Frosted (Rosacea) and Melasma as DIFFERENT boxes, not one silver class', () => {
    // Frosted = Luxe *FS, Melasma = Luxe *WS. Same sizes, different invoices.
    for (const size of ['15g', '30g', '45g']) {
      expect(priced('Rosacea Pump (Frosted)', size).pricePerUnit, size).not.toBe(
        priced('Melasma Pump', size).pricePerUnit,
      );
      expect(priced('Rosacea Pump (Frosted)', size).provenance, size).toMatch(/LUX\d{2}FS/);
      expect(priced('Melasma Pump', size).provenance, size).toMatch(/LUX\d{2}WS/);
    }
  });

  it('breaks the AK pump out fully by size — no more grouped 30/45G band', () => {
    for (const size of ['15g', '30g', '45g', '60g', '100g']) expect(priceFor('AK Pump', size), size).not.toBeNull();
    // Ruling sheet v1.3: 15g and 30g are the SAME box, so the same price.
    expect(priced('AK Pump', '15g').pricePerUnit).toBe(priced('AK Pump', '30g').pricePerUnit);
    expect(priced('AK Pump', '100g').provenance).toContain('60PUR100WF');
    expect(priceFor('AK Pump', '30/45G')).toBeNull();
    expect(priced('AK Pump', '45g').provenance).toContain('59PUR50WF');
    expect(priced('AK Pump', '60g').provenance).toContain('72PUR75WF');
  });

  it('carries no 60g silver row — a large silver fill is N x the 30g box', () => {
    // Carson, 2026-09-25: over 45g counts as N x 30g at the 30g box, because no
    // Frosted or Melasma box exists above 45g. The loader emits sku '30g' for it.
    expect(DEVICE_UNIT_PRICES.some((p) => p.device === 'Rosacea Pump (Frosted)' && p.sku === '60g')).toBe(false);
    expect(DEVICE_UNIT_PRICES.some((p) => p.device === 'Melasma Pump' && p.sku === '60g')).toBe(false);
  });

  it('renames the Kiss Me Goodnight jar to the Orbit Jar, keeping its price', () => {
    // Priced off the Orbit 30 ML acrylic jar (32ORB30CW), not the Echo airless jar.
    expect(priced('Orbit Jar', '').pricePerUnit).toBe(1.69);
    expect(priced('Orbit Jar', '').provenance).toContain('Orbit 30 ML');
    expect(priceFor('White & Silver Jar', '')).toBeNull();
  });

  it('uses only the ruling-sheet device names — no retired name can price', () => {
    // Carson 2026-09-25: every system converges on DEVICE-RULINGS.md §1.
    const retired = [
      'Rosacea Pump', 'Amber Drop Bottle', 'Nail Brush Bottle', 'Foam Pump', 'Roller Bottle',
      'Lip Gloss Tube', 'V-Line Mask Pack', 'Perioral Lip Ointment', 'White & Silver Jar',
    ];
    for (const name of retired) {
      expect(DEVICE_UNIT_PRICES.some((p) => p.device === name), name).toBe(false);
    }
  });

  it('prices the loader-emitted size labels of single-size devices via the fallback', () => {
    expect(priced('Foam Bottle', '55mL').pricePerUnit).toBe(1.4);
    expect(priced('Solution Bottle', '1oz dropper').pricePerUnit).toBe(0.68);
    expect(priced('Wart Pen', '10g').pricePerUnit).toBe(1.23);
  });

  it('prices every wart fill as a 10g pen — no pen/tube split (sheet v1.5)', () => {
    expect(DEVICE_UNIT_PRICES.filter((p) => p.device === 'Wart Pen')).toHaveLength(1);
    expect(priced('Wart Pen', '10g').pricePerUnit).toBe(1.23);
  });

  it('discloses the two new devices as unpriced', () => {
    expect(priceFor('Lip Balm', '')).toBeNull();
    expect(unpricedReason('Lip Balm')).toContain('NEW DEVICE');
    expect(priceFor('Perioral Lip Ointment Jar', '')).toBeNull();
    expect(unpricedReason('Perioral Lip Ointment Jar')).toContain('NEW DEVICE');
  });
});

describe('the corrections that moved the most money', () => {
  it('holds the amber dropper at the corrected 0.68, not the 28%-low 0.49', () => {
    // 71,072 units x +0.19 = ~+$13.7k of COGS — the single largest price correction.
    expect(priced('Solution Bottle', '1oz dropper').pricePerUnit).toBe(0.68);
  });

  it('keeps the 4 oz jar cheaper than the 10 oz', () => {
    // The old 0.84 anchor made the 4 oz nearly dearer than the 10 oz, which is how
    // the error was spotted.
    expect(priced('Ointment Jar', '4oz').pricePerUnit).toBeLessThan(
      priced('Ointment Jar', '10oz').pricePerUnit,
    );
    expect(priced('Ointment Jar', '2oz').pricePerUnit).toBeLessThan(
      priced('Ointment Jar', '4oz').pricePerUnit,
    );
  });

  it('keeps the nail brush bottle as the SUM of its two components', () => {
    // 0.4310 cap + 0.2097 bottle. Someone will eventually try to "correct" this
    // down to one component; this is the note that stops them.
    expect(priced('Nail Bottle', '').pricePerUnit).toBeCloseTo(0.431 + 0.2097, 2);
  });

  it('prices the wart pen at its LANDED floor, ocean freight excluded', () => {
    expect(priced('Wart Pen', '').pricePerUnit).toBe(1.23);
    expect(priced('Wart Pen', '').provenance).toContain('FLOOR');
  });
});

describe('lookup behaviour', () => {
  it('falls back to a device single-SKU row when the exact SKU is absent', () => {
    // A loader-side SKU band that splits later must not silently drop to zero.
    expect(priceFor('Foam Bottle', 'some-new-band')?.pricePerUnit).toBe(1.4);
  });

  it('returns null for an unknown device rather than a zero', () => {
    expect(priceFor('Not A Device', '')).toBeNull();
  });

  it('gives a reason for every unpriced device', () => {
    for (const u of UNPRICED) {
      expect(unpricedReason(u.device), u.device).toBeTruthy();
    }
  });

  it('refuses to price the syringe, whose anchor has no invoice', () => {
    expect(priceFor('Syringes', '10mL airless')).toBeNull();
    expect(unpricedReason('Syringes')).toContain('NOT VERIFIED');
  });

  it('does not confuse the airless dispenser with the in-lab luer syringe', () => {
    // Two different physical items; the cheap Amazon luer syringes are the in-lab
    // wetting-agent consumable and are 40x lower. Substituting one for the other
    // would understate the packaging relief by ~$43k.
    expect(unpricedReason('Syringes')).toContain('luer');
  });
});
