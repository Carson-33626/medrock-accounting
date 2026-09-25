/**
 * Packaging COGS from standard cost — the contributor that finally relieves 1220.15.
 *
 *     packaging COGS(location, month) = Σ units_consumed × price_per_unit
 *
 * Units come from the loader (`inventory.device_usage_monthly`), prices from
 * `device-prices.ts`. This module is the pure arithmetic and the journal lines;
 * `device-cost-server.ts` does the reading.
 *
 * WHAT THIS IS AND IS NOT. It is not an accrual and it does not reverse — unlike
 * the lab-supplies pair, which estimates unbilled purchases. It is the relief that
 * 1220.15 has never had: packaging was capitalised on purchase and nothing ever
 * took it back off. So `Dr Cost of Goods Sold:Compound Packaging /
 * Cr Inventory Asset:Compound Packaging Inventory`, and it stays posted.
 *
 * THE MARCH BACK-FILL. Carson, 2026-09-03, on how the catch-up should work:
 * *"Can't we fill backwards and do a large true-up in March like we planned for
 * inventory"*. So the March entry carries January and February as well as March,
 * and from April each month carries only itself. `monthsCovered` says which, and
 * the memo says so on the face of the entry — a three-month catch-up must not
 * read as one month of packaging consumption.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not drive 1220.15 to a target balance.
 * Carson, 2026-09-04, on whether packaging on hand can be counted: *"Not possible
 * to know, would take extensive work to do a physical inventory, likely will happen
 * when regular inventory is done."* A target of zero would write off $347,920.24 and
 * a target of one month's usage ~$298,000, and the difference between those is a
 * guess with $50k of spread. So this posts only what it can measure — modelled
 * consumption — and the pre-2026 accumulation stays on the balance sheet as a
 * disclosed reconciling item until the physical count settles it. See
 * `ds-device-standard-cost-2026-09-03.md` §9.2, which named the count as the way
 * out; this is what happens while we wait for it.
 */
import type { JournalLine } from '@/lib/payroll/types';
import type { JeContribution } from './je-pool';
import { accountsForCategory } from './category-accounts';
import { priceFor, unpricedReason } from './device-prices';

/** The RDS category whose accounts this contributor posts to. */
export const PACKAGING_CATEGORY = 'Lab Compound Packaging Inventory';

/** First month of the standard-cost model. Per the 2026-forward scope ruling. */
export const DEVICE_COST_FIRST_MONTH = '2026-01';

/** The month the back-fill lands in — the correction period. */
export const DEVICE_COST_TRUEUP_MONTH = '2026-03';

/** One `(location, month, device, sku)` cell of modelled usage, as the loader emits it. */
export interface DeviceUsageRow {
  readonly asOfMonth: string;
  readonly location: string;
  readonly device: string;
  readonly sku: string;
  readonly fills: number;
  readonly units: number;
  readonly confidence: string;
  /**
   * Whether the unit drew down a real FIFO lot, matched no receipt, or belongs to
   * a device we have never received. All three are REAL consumption and all three
   * are valued here — 'unpurchased' is roughly 54,500 units a year that the FIFO
   * close cannot see at all, which is much of why 1220.15 never gets relieved.
   */
  readonly disposition: 'depleted' | 'unpurchased' | 'unresolved';
}

/**
 * Devices that are measured and shown but must NOT produce a packaging line.
 *
 * CARSON, 2026-09-04, on the eye pads: *"They are technically compound ingredient
 * since they are part of the formula, but the lifefile system will not pull them
 * down, so we'll need to fold it in as if it was a device."*
 *
 * Folded in — but for VISIBILITY, not for a second relief. Eye pads are bought
 * into `1220.10 Compound Ingredient` (27 lines / $934.86 in 2026; 2 to 1220.20,
 * 1 to 1220.15), so crediting them against packaging would charge 1220.15 for
 * something in the ingredient pool.
 *
 * Crediting them against 1220.10 instead would be worse, not better. Eye pads
 * have no LifeFile receipts at all — they are an Amazon buy that never enters the
 * lot ledger — so the FIFO close's Compound Ingredient line, which posts
 * `FIFO target − QuickBooks book balance`, is ALREADY sweeping the whole $934.86
 * out of 1220.10. A device line on the same account would relieve it a second
 * time. One mechanism per category.
 *
 * So the units are counted, priced, and carried into the detail sheet where the
 * lab's consumption is visible — which is what "the lifefile system will not pull
 * them down" is really complaining about — and the dollars stay with the FIFO
 * line that already handles them. ~$1,000/year either way.
 */
export const MEASURED_NOT_RELIEVED: ReadonlyMap<string, string> = new Map([
  [
    'Eye Pad Pack',
    'Bought into 1220.10 Compound Ingredient, not packaging. The FIFO close already ' +
      'sweeps it via target-vs-book because it has no lot-ledger receipts, so a device ' +
      'line here would relieve the same $934.86 twice. Counted and priced for visibility only.',
  ],
]);

/** One priced device line, kept for the detail sheet. */
export interface DeviceCostLine {
  readonly device: string;
  readonly sku: string;
  readonly units: number;
  readonly fills: number;
  readonly pricePerUnit: number;
  readonly value: number;
  readonly confidence: string;
  /**
   * When set, the line is shown and priced but its value is NOT in `total` and it
   * posts nothing — the string says which other mechanism already relieves it.
   * See `MEASURED_NOT_RELIEVED`.
   */
  readonly notRelieved?: string;
}

/** What one entity's month values out to, with everything it could not price. */
export interface DeviceCostResult {
  readonly location: string;
  readonly monthsCovered: readonly string[];
  readonly lines: readonly DeviceCostLine[];
  readonly total: number;
  /** Devices with units but no price — disclosed, never valued at zero silently. */
  readonly unpricedUnits: ReadonlyMap<string, number>;
}

/** Round half-up to cents, so two groupings cannot land a cent apart. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Which months one close month is responsible for.
 *
 * March carries January and February with it; every other month carries itself.
 * A month before the model starts carries nothing at all rather than reaching
 * back into 2025 — the scope ruling is 2026 forward, corrections in March/April.
 */
export function monthsCoveredBy(closeMonth: string): readonly string[] {
  if (closeMonth < DEVICE_COST_FIRST_MONTH) return [];
  if (closeMonth !== DEVICE_COST_TRUEUP_MONTH) return [closeMonth];
  const months: string[] = [];
  const [y, m] = DEVICE_COST_FIRST_MONTH.split('-').map(Number);
  for (let cursor = new Date(Date.UTC(y, m - 1, 1)); ; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const label = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push(label);
    if (label === DEVICE_COST_TRUEUP_MONTH) break;
  }
  return months;
}

/**
 * Value one entity's usage for the months a close month covers.
 *
 * Usage rows outside `monthsCovered` are ignored rather than an error — the caller
 * reads a window and this decides what belongs in the entry.
 */
export function valueDeviceUsage(
  location: string,
  closeMonth: string,
  usage: readonly DeviceUsageRow[],
): DeviceCostResult {
  const monthsCovered = monthsCoveredBy(closeMonth);
  const inScope = new Set(monthsCovered);

  // (device, sku) -> accumulated units and fills across every covered month.
  const byDevice = new Map<string, { device: string; sku: string; units: number; fills: number; confidence: string }>();
  for (const row of usage) {
    if (row.location !== location || !inScope.has(row.asOfMonth)) continue;
    const key = `${row.device}||${row.sku}`;
    const slot = byDevice.get(key);
    if (slot) {
      slot.units += row.units;
      slot.fills += row.fills;
    } else {
      byDevice.set(key, {
        device: row.device,
        sku: row.sku,
        units: row.units,
        fills: row.fills,
        confidence: row.confidence,
      });
    }
  }

  const lines: DeviceCostLine[] = [];
  const unpricedUnits = new Map<string, number>();
  let total = 0;

  for (const slot of byDevice.values()) {
    const price = priceFor(slot.device, slot.sku);
    if (price === null) {
      if (slot.units > 0) {
        unpricedUnits.set(slot.device, (unpricedUnits.get(slot.device) ?? 0) + slot.units);
      }
      continue;
    }
    const value = cents(slot.units * price.pricePerUnit);
    if (value === 0) continue;
    const notRelieved = MEASURED_NOT_RELIEVED.get(slot.device);
    lines.push({
      device: slot.device,
      sku: slot.sku,
      units: slot.units,
      fills: slot.fills,
      pricePerUnit: price.pricePerUnit,
      value,
      confidence: price.confidence,
      ...(notRelieved === undefined ? {} : { notRelieved }),
    });
    // Shown, priced, and deliberately outside the posted total.
    if (notRelieved === undefined) total = cents(total + value);
  }

  // Biggest dollars first — the reviewer's eye should land on the pumps.
  lines.sort((a, b) => b.value - a.value || a.device.localeCompare(b.device));

  return { location, monthsCovered, lines, total, unpricedUnits };
}

/** The memo both halves of the pair carry, so the entry explains itself on its face. */
export function deviceCostMemo(result: DeviceCostResult): string {
  const { monthsCovered } = result;
  if (monthsCovered.length <= 1) {
    return `Packaging consumed at standard cost — ${monthsCovered[0] ?? 'no month'}`;
  }
  return (
    `Packaging consumed at standard cost — CATCH-UP covering ` +
    `${monthsCovered[0]} through ${monthsCovered[monthsCovered.length - 1]} ` +
    `(${monthsCovered.length} months), not one month of consumption`
  );
}

/**
 * The contributor.
 *
 * `available` is false when the usage read failed, so the pool refuses to post a
 * packaging-shaped hole rather than shipping an entry that is quietly missing it.
 * A month that genuinely consumed nothing is available with no lines — those are
 * different facts and the pool keeps them apart.
 */
export function deviceCostContribution(
  location: string,
  closeMonth: string,
  usage: readonly DeviceUsageRow[] | null,
): JeContribution {
  const accounts = accountsForCategory(PACKAGING_CATEGORY);
  const warnings: string[] = [];

  if (usage === null) {
    return {
      source: 'device-standard-cost',
      label: 'Packaging at standard cost',
      lines: [],
      warnings: ['Device usage could not be read — packaging relief is missing from this entry.'],
      available: false,
    };
  }

  const result = valueDeviceUsage(location, closeMonth, usage);
  const memo = deviceCostMemo(result);
  const lines: JournalLine[] = [];

  if (result.total > 0) {
    const sourceRowKeys = result.lines.map((l) => `device|${l.device}|${l.sku}`);
    lines.push(
      {
        postingType: 'Debit',
        amount: result.total,
        accountName: accounts.cogs,
        departmentName: null,
        className: null,
        memo,
        creditBucket: null,
        origin: 'generated',
        sourceRowKeys,
      },
      {
        postingType: 'Credit',
        amount: result.total,
        accountName: accounts.inventory,
        departmentName: null,
        className: null,
        memo,
        creditBucket: null,
        origin: 'generated',
        sourceRowKeys,
      },
    );
  }

  if (result.monthsCovered.length > 1) {
    warnings.push(
      `Packaging line is a ${result.monthsCovered.length}-month catch-up ` +
        `(${result.monthsCovered[0]} → ${result.monthsCovered[result.monthsCovered.length - 1]}), ` +
        'not one month of consumption — label it as such on the close package.',
    );
  }

  for (const line of result.lines) {
    if (line.notRelieved === undefined) continue;
    warnings.push(
      `${line.units.toLocaleString()} ${line.device} units ($${line.value.toFixed(2)}) are ` +
        `shown but NOT relieved here — ${line.notRelieved}`,
    );
  }

  for (const [device, units] of [...result.unpricedUnits].sort((a, b) => b[1] - a[1])) {
    const reason = unpricedReason(device);
    warnings.push(
      `${units.toLocaleString()} ${device} units consumed but NOT valued` +
        (reason ? ` — ${reason}` : ' — no price in the standard-cost table.'),
    );
  }

  warnings.push(
    'This relieves measured consumption only. It does not drive 1220.15 to a target, ' +
      'so the pre-2026 accumulation remains on the balance sheet until a physical count ' +
      'of packaging settles it.',
  );

  return {
    source: 'device-standard-cost',
    label: 'Packaging at standard cost',
    lines,
    warnings,
    available: true,
  };
}
